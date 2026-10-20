import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { api, type User } from '../api';
import { ErrorNote, Spinner } from '../components/ui';

function AuthLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true" />
          apiloupe
        </div>
        <h1>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
        {children}
      </div>
    </main>
  );
}

function useSignedIn() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  return async () => {
    await qc.invalidateQueries({ queryKey: ['auth'] });
    navigate('/', { replace: true });
  };
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const done = useSignedIn();
  const login = useMutation({
    mutationFn: () => api.post<{ user: User }>('/auth/login', { email, password }),
    onSuccess: done,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <AuthLayout title="Sign in">
      <form className="form" onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorNote error={login.error} />
        <button className="button primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted small">
        Forgotten your password? An admin can reset it with{' '}
        <code>apiloupe-server reset-password</code>.
      </p>
    </AuthLayout>
  );
}

export function SetupPage() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const done = useSignedIn();
  const setup = useMutation({
    mutationFn: () => api.post<{ user: User }>('/auth/setup', { code, name, email, password }),
    onSuccess: done,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setup.mutate();
  };
  return (
    <AuthLayout
      title="Create the first admin"
      intro={
        <>
          This server has no accounts yet. Enter the setup code from the server log (
          <code>docker compose logs app</code>), then choose your sign-in.
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <label>
          Setup code
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            autoFocus
          />
        </label>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          <span>
            Password <span className="muted">(10 characters or more)</span>
          </span>
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <ErrorNote error={setup.error} />
        <button className="button primary" disabled={setup.isPending}>
          {setup.isPending ? 'Creating…' : 'Create admin and sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}

export function InvitePage({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const done = useSignedIn();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () =>
      api.get<{ email: string; role: string }>(`/auth/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () =>
      api.post(`/auth/invites/${encodeURIComponent(token)}/accept`, { name, password }),
    onSuccess: done,
  });
  if (invite.isPending) {
    return (
      <AuthLayout title="Join apiloupe">
        <Spinner />
      </AuthLayout>
    );
  }
  if (invite.isError) {
    return (
      <AuthLayout title="Invite not valid">
        <ErrorNote error={invite.error} />
        <p className="muted">Ask the admin who invited you for a new link.</p>
      </AuthLayout>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    accept.mutate();
  };
  return (
    <AuthLayout
      title="Join apiloupe"
      intro={
        <>
          You were invited as <strong>{invite.data.email}</strong> ({invite.data.role}).
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <label>
          Your name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            autoFocus
          />
        </label>
        <label>
          <span>
            Password <span className="muted">(10 characters or more)</span>
          </span>
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <ErrorNote error={accept.error} />
        <button className="button primary" disabled={accept.isPending}>
          {accept.isPending ? 'Joining…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
