import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieFrom,
  hasDatabase,
  ORIGIN,
  SETUP_CODE,
  setupAdmin,
  testApp,
  type TestApp,
} from './helpers.js';

const PASSWORD = 'correct horse battery';

describe.skipIf(!hasDatabase)('sign-in and accounts', () => {
  let t: TestApp;
  let adminCookie: string;

  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  const post = (url: string, payload: object, cookie?: string) =>
    t.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    });

  it('starts in setup mode, and setup needs the code from the server log', async () => {
    const state = await t.app.inject({ url: '/api/v1/auth/state' });
    expect(state.json()).toEqual({ setupRequired: true, user: null });

    const wrong = await post('/api/v1/auth/setup', {
      code: 'WRONG-CODE-0000',
      email: 'admin@example.com',
      password: PASSWORD,
    });
    expect(wrong.statusCode).toBe(403);

    const short = await post('/api/v1/auth/setup', {
      code: SETUP_CODE,
      email: 'a@example.com',
      password: 'short',
    });
    expect(short.statusCode).toBe(400);
  });

  it('creates the first admin, signs them in, then refuses a second setup', async () => {
    adminCookie = await setupAdmin(t.app);
    const me = await t.app.inject({ url: '/api/v1/auth/me', headers: { cookie: adminCookie } });
    expect(me.json()).toMatchObject({ user: { email: 'admin@example.com', role: 'admin' } });

    const again = await post('/api/v1/auth/setup', {
      code: SETUP_CODE,
      email: 'x@example.com',
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(409);
    const state = await t.app.inject({ url: '/api/v1/auth/state' });
    expect(state.json()).toMatchObject({ setupRequired: false });
  });

  it('sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await post('/api/v1/auth/login', {
      email: 'ADMIN@example.com',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers['set-cookie']);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    // Plain http in tests: no Secure flag, no __Host- prefix.
    expect(header).not.toContain('Secure');
  });

  it('refuses a wrong password without saying whether the email exists', async () => {
    const wrong = await post('/api/v1/auth/login', {
      email: 'admin@example.com',
      password: 'not the password',
    });
    const missing = await post('/api/v1/auth/login', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json()).toEqual(missing.json());
  });

  it('locks an email out after repeated failures', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await post('/api/v1/auth/login', {
          email: 'victim@example.com',
          password: 'guess guess ' + i,
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it('refuses state-changing requests from another origin', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'x' },
      headers: { cookie: adminCookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires a session for data and admin rights for admin routes', async () => {
    expect((await t.app.inject({ url: '/api/v1/projects' })).statusCode).toBe(401);

    const invite = await post(
      '/api/v1/invites',
      { email: 'member@example.com', role: 'member' },
      adminCookie,
    );
    expect(invite.statusCode).toBe(201);
    const { token } = invite.json<{ token: string }>();

    const lookup = await t.app.inject({ url: `/api/v1/auth/invites/${token}` });
    expect(lookup.json()).toEqual({ email: 'member@example.com', role: 'member' });

    const accepted = await post(`/api/v1/auth/invites/${token}/accept`, {
      name: 'Mem',
      password: PASSWORD,
    });
    expect(accepted.statusCode).toBe(201);
    const memberCookie = cookieFrom(accepted);

    // An invite works once.
    const reused = await post(`/api/v1/auth/invites/${token}/accept`, {
      name: 'Mem',
      password: PASSWORD,
    });
    expect(reused.statusCode).toBe(404);

    expect(
      (await t.app.inject({ url: '/api/v1/projects', headers: { cookie: memberCookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ url: '/api/v1/users', headers: { cookie: memberCookie } })).statusCode,
    ).toBe(403);
    expect((await post('/api/v1/projects', { name: 'Nope' }, memberCookie)).statusCode).toBe(403);
  });

  it('disabling a user ends their sessions; the last admin cannot be removed', async () => {
    const users = (
      await t.app.inject({ url: '/api/v1/users', headers: { cookie: adminCookie } })
    ).json<{
      users: { id: number; email: string }[];
    }>();
    const member = users.users.find((u) => u.email === 'member@example.com')!;
    const admin = users.users.find((u) => u.email === 'admin@example.com')!;

    const login = await post('/api/v1/auth/login', {
      email: 'member@example.com',
      password: PASSWORD,
    });
    const memberCookie = cookieFrom(login);
    const patch = (id: number, payload: object) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${id}`,
        payload,
        headers: { cookie: adminCookie, origin: ORIGIN },
      });

    expect((await patch(member.id, { disabled: true })).statusCode).toBe(200);
    expect(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: { cookie: memberCookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post('/api/v1/auth/login', { email: 'member@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(401);

    expect((await patch(admin.id, { role: 'member' })).statusCode).toBe(409);
    // Promote the member, then the original admin may step down.
    await patch(member.id, { disabled: false, role: 'admin' });
    expect((await patch(admin.id, { role: 'member' })).statusCode).toBe(409); // not yourself
  });

  it('changing your password signs out your other sessions', async () => {
    const other = cookieFrom(
      await post('/api/v1/auth/login', { email: 'admin@example.com', password: PASSWORD }),
    );
    const res = await post(
      '/api/v1/auth/password',
      { currentPassword: PASSWORD, newPassword: 'an even longer password' },
      adminCookie,
    );
    expect(res.statusCode).toBe(204);
    expect(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: { cookie: other } })).statusCode,
    ).toBe(401);
    expect(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: { cookie: adminCookie } })).statusCode,
    ).toBe(200);
  });

  it('logout ends the session', async () => {
    const res = await post('/api/v1/auth/logout', {}, adminCookie);
    expect(res.statusCode).toBe(204);
    expect(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: { cookie: adminCookie } })).statusCode,
    ).toBe(401);
  });
});
