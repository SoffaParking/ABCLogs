import { describe, expect, it } from 'vitest';
import { pathOnly, routeFromPath } from '../src/index.js';

describe('pathOnly', () => {
  it('drops the query string, fragment and origin', () => {
    expect(pathOnly('/a/b?x=1#y')).toBe('/a/b');
    expect(pathOnly('https://api.example.com/v1/users?id=2')).toBe('/v1/users');
    expect(pathOnly('https://api.example.com')).toBe('/');
    expect(pathOnly('')).toBe('/');
  });
});

describe('routeFromPath', () => {
  it.each([
    ['/', '/'],
    ['/api/users/42', '/api/users/:id'],
    ['/api/users/42/plates/B12345', '/api/users/:id/plates/:id'],
    ['/orders/0f8fad5b-d9cb-469f-a165-70867728950e', '/orders/:uuid'],
    ['/blobs/5f2b9c0e1a7d4e3f9a8b', '/blobs/:hex'],
    ['/reports/2026-10-19', '/reports/:date'],
    ['/users/someone@example.com', '/users/:email'],
    ['/plates/%D8%A8%D9%A1', '/plates/:param'],
    ['/v1/oauth2/ipv4/health', '/v1/oauth2/ipv4/health'],
    ['/api/users/42?expand=1', '/api/users/:id'],
    ['/api/users/', '/api/users/'],
  ])('%s → %s', (path, route) => {
    expect(routeFromPath(path)).toBe(route);
  });
});
