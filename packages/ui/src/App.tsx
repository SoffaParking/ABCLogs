import { useEffect, useState } from 'react';

interface Meta {
  name: string;
  levels: string[];
}

type State = { kind: 'loading' } | { kind: 'ok'; meta: Meta } | { kind: 'error'; message: string };

/** Placeholder until the dashboard pages land in M1: proves the UI reaches the server. */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/v1/meta')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({ kind: 'ok', meta: (await res.json()) as Meta });
      })
      .catch((err: unknown) => {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }, []);

  return (
    <main className="placeholder">
      <h1>apiloupe</h1>
      <p>API requests and errors, by verbosity. The dashboard is under construction.</p>
      {state.kind === 'loading' && <p className="muted">Connecting to the server…</p>}
      {state.kind === 'error' && <p className="error">Server unreachable: {state.message}</p>}
      {state.kind === 'ok' && (
        <p className="muted">Server connected. Levels: {state.meta.levels.join(' · ')}</p>
      )}
    </main>
  );
}
