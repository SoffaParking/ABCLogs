import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

/**
 * A stand-in apiloupe ingest endpoint that deduplicates by event id like the
 * real one, so resumed and repeated imports can be checked.
 */
export async function fakeIngest(fail?: (batch: number) => number | undefined) {
  const stored = new Map<string, Record<string, unknown>>();
  let batches = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ingest/v1/check') {
        res.end('{"ok":true}');
        return;
      }
      const status = fail?.(batches++);
      if (status) {
        res.statusCode = status;
        res.end('{"error":"refused"}');
        return;
      }
      const { events } = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()) as {
        events: Record<string, unknown>[];
      };
      let accepted = 0;
      for (const e of events) {
        if (stored.has(e.id as string)) continue;
        stored.set(e.id as string, e);
        accepted += 1;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted, duplicates: events.length - accepted, rejected: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stored,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
