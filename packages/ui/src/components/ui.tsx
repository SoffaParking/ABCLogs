import { levelName, statusClass } from '@apiloupe/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

export function LevelBadge({ level }: { level: number }) {
  const name = levelName(level);
  return <span className={`badge level-${name}`}>{name}</span>;
}

export function StatusBadge({ status }: { status: number }) {
  return <span className={`badge status-${statusClass(status)}`}>{status}</span>;
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`card ${className ?? ''}`}
      aria-busy={className?.includes('stale') || undefined}
    >
      {(title || actions) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** A row of mutually exclusive buttons. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; className?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`${option.value === value ? 'active' : ''} ${option.className ?? ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  return (
    <p className="error-note" role="alert">
      {message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status" aria-label={label} />;
}

/** A button that copies text, confirming briefly. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="button small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A panel sliding in from the right, closed by Escape or the backdrop. */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="button ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Key-value pairs, for event details. */
export function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fields">
      {rows.map(([key, value]) => (
        <div key={key} className="field">
          <dt>{key}</dt>
          <dd>{value ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Json({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="muted">none</span>;
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
