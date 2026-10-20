/**
 * Turns a concrete path into a route pattern for grouping, when the sender did
 * not say which route served the request: `/users/42/orders/9f1c…` becomes
 * `/users/:id/orders/:uuid`. Without this every id would be its own "route"
 * and the charts would be useless.
 */
export function routeFromPath(path: string): string {
  const clean = pathOnly(path);
  if (clean === '/' || clean === '') return '/';
  return clean
    .split('/')
    .map((segment) => (segment === '' ? segment : normalizeSegment(segment)))
    .join('/');
}

/** The path without query string or fragment; a full URL is reduced to its path. */
export function pathOnly(url: string): string {
  let path = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (scheme) path = path.slice(scheme[0].length) || '/';
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  return path === '' ? '/' : path;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

function normalizeSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return ':id';
  if (UUID.test(segment)) return ':uuid';
  if (DATE.test(segment)) return ':date';
  if (HEX.test(segment)) return ':hex';
  if (segment.includes('%')) return ':param';
  if (EMAIL.test(segment)) return ':email';
  const digits = segment.replace(/\D/g, '').length;
  // Mixed letters and digits with at least two digits (B12345, a1b2c3d4)
  // are ids; v1, oauth2 and ipv4 are not.
  if (segment.length >= 6 && digits >= 2 && /[a-z]/i.test(segment)) return ':id';
  if (segment.length >= 24) return ':token';
  return segment;
}
