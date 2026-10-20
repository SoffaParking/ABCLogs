import type pg from 'pg';
import type { StoredRequest } from './validate.js';

/** The route requests are counted under once a project has used up its routes. */
export const OVERFLOW_ROUTE = '(other)';

/**
 * Caps the distinct routes per project. A sender that puts ids into its route
 * names would otherwise create a new rollup series per id. Routes past the cap
 * are counted under {@link OVERFLOW_ROUTE}; their raw events keep the path.
 */
export class RouteCap {
  private readonly known = new Map<number, Set<string>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly max: number,
  ) {}

  async apply(projectId: number, requests: StoredRequest[]): Promise<void> {
    if (requests.length === 0) return;
    let known = this.known.get(projectId);
    if (!known) {
      const { rows } = await this.pool.query<{ route: string }>(
        'SELECT route FROM project_routes WHERE project_id = $1',
        [projectId],
      );
      known = new Set(rows.map((row) => row.route));
      this.known.set(projectId, known);
    }
    const unseen = [...new Set(requests.map((r) => r.route))].filter((route) => !known.has(route));
    if (unseen.length > 0) {
      await this.pool.query(
        `INSERT INTO project_routes (project_id, route)
         SELECT $1, r FROM unnest($2::text[]) AS r
          LIMIT greatest($3 - (SELECT count(*) FROM project_routes WHERE project_id = $1), 0)
         ON CONFLICT DO NOTHING`,
        [projectId, unseen, this.max],
      );
      const { rows } = await this.pool.query<{ route: string }>(
        'SELECT route FROM project_routes WHERE project_id = $1 AND route = ANY($2)',
        [projectId, unseen],
      );
      for (const row of rows) known.add(row.route);
    }
    for (const request of requests) {
      if (!known.has(request.route)) request.route = OVERFLOW_ROUTE;
    }
  }

  forget(projectId: number): void {
    this.known.delete(projectId);
  }
}
