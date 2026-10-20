import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';

export interface Received {
  headers: IncomingMessage['headers'];
  events: Record<string, unknown>[];
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A stand-in apiloupe server that records batches; `reply` decides each answer. */
export async function fakeServer(reply: (n: number) => Reply = () => ({ status: 202 })) {
  const received: Received[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text =
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString();
      const { events } = JSON.parse(text) as { events: Record<string, unknown>[] };
      const out = reply(n++);
      if (out.status === 202) received.push({ headers: req.headers, events });
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.body ?? { accepted: events.length, duplicates: 0, rejected: [] }));
    });
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    events: () => received.flatMap((r) => r.events),
    close: () => close(server),
  };
}

/** Accepts connections and never answers: the worst kind of unreachable. */
export async function blackhole() {
  const sockets = new Set<Socket>();
  const server = createServer(() => undefined);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      return close(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
