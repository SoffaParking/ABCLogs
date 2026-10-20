import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { api, type IngestKey, type Project, type Role, type User } from '../api';
import { useProjects } from '../components/Shell';
import { Card, CopyButton, Empty, ErrorNote, Spinner } from '../components/ui';
import { formatAgo } from '../format';

export function SettingsPage({
  user,
  tab,
  item,
}: {
  user: User;
  tab?: string | undefined;
  item?: string | undefined;
}) {
  const isAdmin = user.role === 'admin';
  const current = tab ?? 'projects';
  const tabs = [
    { id: 'projects', label: 'Projects' },
    ...(isAdmin ? [{ id: 'users', label: 'Users' }] : []),
    { id: 'account', label: 'Your account' },
  ];
  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <nav className="subtabs">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={`/settings/${t.id}`}
            className={current === t.id ? 'tab active' : 'tab'}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {current === 'projects' && !item && <ProjectList isAdmin={isAdmin} />}
      {current === 'projects' && item && <ProjectSettings slug={item} isAdmin={isAdmin} />}
      {current === 'users' && isAdmin && <Users me={user} />}
      {current === 'account' && <Account user={user} />}
    </div>
  );
}

function ProjectList({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/projects', { name }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  if (projects.isPending) return <Spinner />;
  if (projects.isError) return <ErrorNote error={projects.error} />;
  return (
    <>
      <Card title="Projects">
        {projects.data.projects.length === 0 ? (
          <Empty>No projects yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Last data received</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    {isAdmin ? <Link href={`/settings/projects/${p.slug}`}>{p.name}</Link> : p.name}
                  </td>
                  <td>
                    <code>{p.slug}</code>
                  </td>
                  <td className="muted">{formatAgo(p.lastIngestAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {isAdmin && (
        <Card title="New project">
          <form
            className="form inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input
              required
              aria-label="Project name"
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="button primary" disabled={create.isPending}>
              Create
            </button>
          </form>
          <ErrorNote error={create.error} />
        </Card>
      )}
    </>
  );
}

function ProjectSettings({ slug, isAdmin }: { slug: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const projects = useProjects();
  const project = projects.data?.projects.find((p) => p.slug === slug);
  const keys = useQuery({
    queryKey: ['keys', slug],
    queryFn: () => api.get<{ keys: IngestKey[] }>(`/projects/${slug}/keys`),
    enabled: isAdmin,
  });
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  const createKey = useMutation({
    mutationFn: () =>
      api.post<{ key: string }>(`/projects/${slug}/keys`, { name: keyName || 'default' }),
    onSuccess: ({ key }) => {
      setNewKey(key);
      setKeyName('');
      void qc.invalidateQueries({ queryKey: ['keys', slug] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/${slug}/keys/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keys', slug] }),
  });
  const save = useMutation({
    mutationFn: (name: string) => api.patch(`/projects/${slug}`, { name }),
    onSuccess: () => {
      setRename(null);
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${slug}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      navigate('/settings/projects');
    },
  });

  if (projects.isPending) return <Spinner />;
  if (!project) return <ErrorNote error="No such project." />;
  const origin = window.location.origin;
  const shownKey = newKey ?? 'alk_…';

  return (
    <>
      <p>
        <Link href="/settings/projects">← All projects</Link> ·{' '}
        <Link href={`/p/${slug}`}>Open dashboard</Link>
      </p>
      <Card title={project.name}>
        {rename === null ? (
          <p>
            Slug <code>{project.slug}</code>{' '}
            {isAdmin && (
              <button
                type="button"
                className="button small"
                onClick={() => setRename(project.name)}
              >
                Rename
              </button>
            )}
          </p>
        ) : (
          <form
            className="form inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              save.mutate(rename);
            }}
          >
            <input
              aria-label="Project name"
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              required
            />
            <button className="button primary">Save</button>
            <button type="button" className="button ghost" onClick={() => setRename(null)}>
              Cancel
            </button>
          </form>
        )}
        <ErrorNote error={save.error} />
      </Card>

      {isAdmin && (
        <Card title="Ingest keys">
          <p className="muted">
            Senders authenticate with a key. It is shown once, when created; store it in your app’s
            secrets. Revoking a key stops it at once.
          </p>
          {newKey && (
            <div className="new-key">
              <strong>New key, copy it now:</strong>
              <code className="key">{newKey}</code>
              <CopyButton text={newKey} />
            </div>
          )}
          {keys.isPending ? (
            <Spinner />
          ) : keys.isError ? (
            <ErrorNote error={keys.error} />
          ) : keys.data.keys.length === 0 ? (
            <Empty>No keys yet.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data.keys.map((k) => (
                  <tr key={k.id} className={k.revokedAt ? 'revoked' : ''}>
                    <td>{k.name}</td>
                    <td>
                      <code>alk_{k.prefix}_…</code>
                    </td>
                    <td className="muted">{formatAgo(k.createdAt)}</td>
                    <td className="muted">{formatAgo(k.lastUsedAt)}</td>
                    <td className="num">
                      {k.revokedAt ? (
                        <span className="muted">revoked</span>
                      ) : (
                        <button
                          type="button"
                          className="button small danger"
                          onClick={() => {
                            if (
                              window.confirm(`Revoke "${k.name}"? Senders using it stop at once.`)
                            )
                              revoke.mutate(k.id);
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="form inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              createKey.mutate();
            }}
          >
            <input
              aria-label="Key name"
              placeholder="Key name, e.g. production"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <button className="button primary" disabled={createKey.isPending}>
              Create key
            </button>
          </form>
          <ErrorNote error={createKey.error ?? revoke.error} />
        </Card>
      )}

      <Card title="Send data">
        <p>Import existing JSON logs (pino and most JSON loggers) from a file or a pipe:</p>
        <pre className="code">{`pnpm import-logs --endpoint ${origin} --key ${shownKey} app.log`}</pre>
        <p>Or post events from anywhere:</p>
        <pre className="code">{`curl -X POST ${origin}/ingest/v1/events \\
  -H 'Authorization: Bearer ${shownKey}' \\
  -H 'Content-Type: application/json' \\
  -d '{"events":[{"type":"request","time":"${new Date().toISOString()}","method":"GET","path":"/users/42","status":200,"durationMs":12}]}'`}</pre>
        <p className="muted small">
          No data yet? <code>pnpm demo --key {shownKey}</code> sends two hours of synthetic traffic.
        </p>
      </Card>

      {isAdmin && (
        <Card title="Delete project" className="danger-zone">
          <p>Deletes the project, its keys and all of its data. This cannot be undone.</p>
          <form
            className="form inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              remove.mutate();
            }}
          >
            <input
              aria-label="Type the slug to confirm"
              placeholder={`Type ${project.slug} to confirm`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <button
              className="button danger"
              disabled={confirm !== project.slug || remove.isPending}
            >
              Delete project
            </button>
          </form>
          <ErrorNote error={remove.error} />
        </Card>
      )}
    </>
  );
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  disabled: boolean;
}

interface InviteRow {
  id: number;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

function Users({ me }: { me: User }) {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: UserRow[]; invites: InviteRow[] }>('/users'),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; role?: Role; disabled?: boolean }) =>
      api.patch(`/users/${id}`, body),
    onSuccess: refresh,
  });
  const invite = useMutation({
    mutationFn: () => api.post<{ token: string }>('/invites', { email, role }),
    onSuccess: ({ token }) => {
      setLink(`${window.location.origin}/invite/${token}`);
      setEmail('');
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api.delete(`/invites/${id}`),
    onSuccess: refresh,
  });

  if (users.isPending) return <Spinner />;
  if (users.isError) return <ErrorNote error={users.error} />;
  return (
    <>
      <Card title="Users">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'revoked' : ''}>
                <td>{u.name || <span className="muted">–</span>}</td>
                <td>{u.email}</td>
                <td>
                  <select
                    aria-label={`Role of ${u.email}`}
                    value={u.role}
                    disabled={u.id === me.id}
                    onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="muted">{formatAgo(u.createdAt)}</td>
                <td className="num">
                  {u.id !== me.id && (
                    <button
                      type="button"
                      className={`button small ${u.disabled ? '' : 'danger'}`}
                      onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorNote error={update.error} />
      </Card>

      <Card title="Invite someone">
        <p className="muted">
          You get a one-time link to send them (valid 7 days). apiloupe does not send email.
        </p>
        <form
          className="form inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <input
            type="email"
            required
            aria-label="Email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">member: can view</option>
            <option value="admin">admin: can also manage</option>
          </select>
          <button className="button primary" disabled={invite.isPending}>
            Create invite link
          </button>
        </form>
        <ErrorNote error={invite.error} />
        {link && (
          <div className="new-key">
            <strong>Invite link, shown once:</strong>
            <code className="key">{link}</code>
            <CopyButton text={link} />
          </div>
        )}
        {users.data.invites.length > 0 && (
          <>
            <h3>Pending invites</h3>
            <table className="table">
              <tbody>
                {users.data.invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.role}</td>
                    <td className="muted">expires {new Date(i.expiresAt).toLocaleDateString()}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="button small"
                        onClick={() => cancel.mutate(i.id)}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}

function Account({ user }: { user: User }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });
  return (
    <div className="narrow">
      <Card title="Your account">
        <p>
          {user.name && <strong>{user.name} </strong>}
          {user.email} · {user.role}
        </p>
      </Card>
      <Card title="Change password">
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <label>
            Current password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            <span>
              New password <span className="muted">(10 characters or more)</span>
            </span>
            <input
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <ErrorNote error={change.error} />
          {change.isSuccess && (
            <p className="ok-note">Password changed. Your other sessions were signed out.</p>
          )}
          <button className="button primary" disabled={change.isPending}>
            Change password
          </button>
        </form>
      </Card>
    </div>
  );
}
