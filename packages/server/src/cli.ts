#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hashPassword, passwordProblem } from './auth/passwords.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { reprocessIssues } from './reprocess.js';

const USAGE = `Usage: apiloupe-server <command> [options]

Commands:
  migrate                               Apply database migrations and exit.
  create-admin --email <e> [--name <n>] Create an admin account.
  reset-password --email <e>            Set a new password for an account
                                        and sign it out everywhere.
  reprocess-issues [--project <slug>]   Regroup stored error events into
                                        issues with the current rules (all
                                        projects by default). Ingest of errors
                                        pauses while it runs.

The password is read from the APILOUPE_PASSWORD environment variable, or
from the first line of standard input:

  echo 'a long password' | apiloupe-server create-admin --email you@example.com

DATABASE_URL must point at the apiloupe database.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function readPassword(): string {
  const fromEnv = process.env.APILOUPE_PASSWORD;
  const password =
    fromEnv ?? (process.stdin.isTTY ? '' : (readFileSync(0, 'utf8').split(/\r?\n/)[0] ?? ''));
  const problem = passwordProblem(password);
  if (problem) fail(`${problem} (set APILOUPE_PASSWORD or pipe it on standard input)`);
  return password;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    project: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const command = positionals[0];
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 2);
}

const pool = createPool(loadConfig().databaseUrl) ?? fail('DATABASE_URL is not set');
try {
  await migrate(pool);
  if (command === 'migrate') {
    console.log('database is up to date');
  } else if (command === 'create-admin') {
    const email = values.email?.trim().toLowerCase() ?? fail('--email is required');
    const hash = await hashPassword(readPassword());
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')
       ON CONFLICT DO NOTHING RETURNING id`,
      [email, values.name ?? '', hash],
    );
    if (!rows[0]) fail(`a user with email ${email} already exists; use reset-password`);
    console.log(`admin ${email} created`);
  } else if (command === 'reset-password') {
    const email = values.email?.trim().toLowerCase() ?? fail('--email is required');
    const hash = await hashPassword(readPassword());
    const { rows } = await pool.query<{ id: number }>(
      'UPDATE users SET password_hash = $2 WHERE lower(email) = $1 RETURNING id',
      [email, hash],
    );
    if (!rows[0]) fail(`no user with email ${email}`);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    console.log(`password for ${email} changed; existing sessions signed out`);
  } else if (command === 'reprocess-issues') {
    const { rows } = await pool.query<{ id: number; slug: string }>(
      values.project
        ? 'SELECT id, slug FROM projects WHERE slug = $1'
        : 'SELECT id, slug FROM projects ORDER BY id',
      values.project ? [values.project] : [],
    );
    if (rows.length === 0) fail(values.project ? `no project ${values.project}` : 'no projects');
    for (const project of rows) {
      const r = await reprocessIssues(pool, Number(project.id));
      console.log(
        `${project.slug}: ${r.events} error events, ${r.moved} regrouped; issues ${r.issuesBefore} → ${r.issuesAfter}`,
      );
    }
  } else {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
} finally {
  await pool.end();
}
