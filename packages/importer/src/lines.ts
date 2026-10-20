import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * The lines of a file or stream, gunzipped when compressed (detected by the
 * gzip magic bytes, not the file name).
 */
export async function* readLines(source: string | Readable): AsyncGenerator<string> {
  const raw = typeof source === 'string' ? createReadStream(source) : source;
  const first = await firstChunk(raw);
  if (first === null) return;
  raw.unshift(first);
  const gzipped = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;
  const input = gzipped ? raw.pipe(createGunzip()) : raw;
  if (gzipped) raw.on('error', (err) => input.destroy(err));
  yield* createInterface({ input, crlfDelay: Infinity });
}

function firstChunk(stream: Readable): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      const chunk = stream.read() as Buffer | string | null;
      if (chunk === null) return;
      cleanup();
      resolve(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}
