import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function config(publicDir = join(tmpdir(), 'apiloupe-no-ui')) {
  return { ...loadConfig({}), logLevel: 'silent', publicDir };
}

function fakePool(answers: boolean): pg.Pool {
  return {
    query: () =>
      answers ? Promise.resolve({ rows: [{ '?column?': 1 }] }) : Promise.reject(new Error('down')),
  } as unknown as pg.Pool;
}

describe('health endpoints', () => {
  it('/healthz answers without a database', async () => {
    const app = await buildApp({ config: config(), pool: null });
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/readyz is 503 when no database is configured', async () => {
    const app = await buildApp({ config: config(), pool: null });
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ database: 'not configured' });
  });

  it('/readyz follows the database', async () => {
    const up = await buildApp({ config: config(), pool: fakePool(true) });
    expect((await up.inject({ url: '/readyz' })).statusCode).toBe(200);
    const down = await buildApp({ config: config(), pool: fakePool(false) });
    const res = await down.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ database: 'unreachable' });
  });
});

describe('security headers', () => {
  it('sends a strict content security policy', async () => {
    const app = await buildApp({ config: config(), pool: null });
    const res = await app.inject({ url: '/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('https:');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('over plain http, never upgrades requests or sends HSTS (it would break the page)', async () => {
    const app = await buildApp({ config: config(), pool: null });
    const res = await app.inject({ url: '/healthz' });
    expect(String(res.headers['content-security-policy'])).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('behind an https PUBLIC_URL, upgrades requests and sends HSTS', async () => {
    const app = await buildApp({
      config: { ...config(), publicUrl: 'https://logs.example.com' },
      pool: null,
    });
    const res = await app.inject({ url: '/healthz' });
    expect(String(res.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('dashboard hosting', () => {
  it('serves the app shell for client routes but 404s unknown API paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apiloupe-ui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>apiloupe</title>');
    const app = await buildApp({ config: config(dir), pool: null });

    const shell = await app.inject({ url: '/issues/42' });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('<title>apiloupe</title>');
    expect((await app.inject({ method: 'HEAD', url: '/issues/42' })).statusCode).toBe(200);

    expect((await app.inject({ url: '/api/v1/nope' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/ingest/v1/nope' })).statusCode).toBe(404);
  });

  it('exposes the level vocabulary at /api/v1/meta', async () => {
    const app = await buildApp({ config: config(), pool: null });
    const res = await app.inject({ url: '/api/v1/meta' });
    expect(res.json()).toEqual({
      name: 'apiloupe',
      version: '1.0.0',
      levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    });
  });
});
