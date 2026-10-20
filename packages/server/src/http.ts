/** An error whose message is safe to show the caller, with its HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = 'sign in required') => new HttpError(401, message);
export const forbidden = (message = 'not allowed') => new HttpError(403, message);
export const notFound = (message = 'not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** A JSON body as a plain object, or a 400. */
export function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

/** A required, trimmed, non-empty string field, or a 400. */
export function requiredString(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} is required`);
  if (value.length > max) throw badRequest(`${key} must be at most ${max} characters`);
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  max = 200,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  if (value.length > max) throw badRequest(`${key} must be at most ${max} characters`);
  return value.trim();
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function requiredEmail(body: Record<string, unknown>, key = 'email'): string {
  const email = requiredString(body, key, 254).toLowerCase();
  if (!EMAIL.test(email)) throw badRequest(`${key} is not an email address`);
  return email;
}
