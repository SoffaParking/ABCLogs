import { parseStack, shortPath } from '@apiloupe/shared';

/**
 * A stack trace with the app's own frames in full colour and dependency and
 * runtime frames dimmed, so the line to look at stands out.
 */
export function StackTrace({ stack }: { stack: string }) {
  const frames = parseStack(stack);
  if (frames.length === 0) return <pre className="code stack">{stack}</pre>;
  const lines = stack.split('\n');
  let frame = 0;
  return (
    <pre className="code stacktrace">
      {lines.map((line, i) => {
        if (!/^\s*at\s/.test(line)) {
          return (
            <span key={i} className="stack-head">
              {line}
              {'\n'}
            </span>
          );
        }
        const f = frames[frame++];
        if (!f)
          return (
            <span key={i}>
              {line}
              {'\n'}
            </span>
          );
        return (
          <span key={i} className={f.inApp ? 'frame in-app' : 'frame'}>
            {'    at '}
            {f.fn && <strong>{f.fn} </strong>}
            <span className="frame-file" title={f.file}>
              {f.inApp ? shortPath(f.file) : f.file}
              {f.line !== null ? `:${f.line}` : ''}
              {f.column !== null ? `:${f.column}` : ''}
            </span>
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
