import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { api, type Project } from '../api';
import { Card, ErrorNote } from '../components/ui';

/** Shown when there are no projects yet. */
export function Onboarding({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/projects', { name }),
    onSuccess: async ({ project }) => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/settings/projects/${project.slug}`);
    },
  });
  if (!isAdmin) {
    return (
      <Card title="No projects yet">
        <p>An admin needs to create a project before there is anything to see.</p>
      </Card>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <div className="narrow">
      <Card title="Create your first project">
        <p className="muted">
          A project is one API (or one environment of it). Each gets its own ingest keys, and its
          data is kept separate.
        </p>
        <form className="form" onSubmit={submit}>
          <label>
            Project name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Payments API (production)"
              autoFocus
            />
          </label>
          <ErrorNote error={create.error} />
          <button className="button primary" disabled={create.isPending}>
            Create project
          </button>
        </form>
      </Card>
    </div>
  );
}
