import http from 'node:http';
import https from 'node:https';

export type PostResult =
  | { ok: true; status: number; retryAfterMs: number | null; body: string }
  | { ok: false; error: Error };

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 2 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 2 }),
};

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POSTs a body and resolves with the response or the error; never rejects.
 *
 * `holdOpen` decides whether this request keeps the process alive. Background
 * sends do not (a script that is done should exit, not wait on telemetry);
 * flushes during shutdown do, with their own deadline.
 */
export function post(
  url: URL,
  body: Buffer,
  headers: Record<string, string>,
  options: { timeoutMs: number; holdOpen: boolean },
): Promise<PostResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const client = url.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      req = client.request(url, {
        method: 'POST',
        agent: agents[url.protocol as 'http:' | 'https:'],
        headers: { ...headers, 'content-length': String(body.length) },
      });
    } catch (err) {
      resolve({ ok: false, error: err as Error });
      return;
    }
    // One deadline for the whole exchange: a black-holed connection never
    // fires the socket's idle timeout.
    const timer = setTimeout(() => {
      req.destroy(new Error(`no response within ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    if (!options.holdOpen) timer.unref();
    req.on('socket', (socket) => {
      if (options.holdOpen) socket.ref();
      else socket.unref();
    });
    req.on('error', (error) => settle({ ok: false, error }));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      res.on('error', (error) => settle({ ok: false, error }));
      res.on('end', () => {
        const retryAfter = Number(res.headers['retry-after']);
        settle({
          ok: true,
          status: res.statusCode ?? 0,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.end(body);
  });
}
