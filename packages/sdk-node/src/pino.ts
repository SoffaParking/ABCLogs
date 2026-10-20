import type { PinoStream } from './index.js';

/**
 * A destination for pino that queues each line as written. Mapping a line to
 * an event (parsing its JSON) waits until the batch is sent, so a log call
 * costs the app one array write.
 */
export function createPinoStream(push: (line: string) => void): PinoStream {
  return {
    write(chunk: string | Uint8Array): boolean {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        // pino writes one line per call, but a stream may be handed several.
        let start = 0;
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', start)) {
          if (i > start) push(text.slice(start, i));
          start = i + 1;
        }
        if (start < text.length) push(text.slice(start));
      } catch {
        // never throw into the logger
      }
      return true;
    },
  };
}
