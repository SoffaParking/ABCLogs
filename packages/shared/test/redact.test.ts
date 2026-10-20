import { describe, expect, it } from 'vitest';
import { isSensitiveKey, REDACTED, redact, redactString } from '../src/index.js';

describe('redact', () => {
  it('masks secrets by key, however the key is spelled', () => {
    for (const key of [
      'password',
      'newPassword',
      'api_key',
      'X-Api-Key',
      'authorization',
      'Cookie',
      'refreshToken',
      'client_secret',
      'cvv',
      'pin',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['user', 'route', 'status', 'opinion', 'spin', 'keyboard']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('walks nested objects and arrays', () => {
    expect(
      redact({ user: { id: 1, password: 'hunter2' }, tokens: ['a'], list: [{ secret: 'x' }] }),
    ).toEqual({
      user: { id: 1, password: REDACTED },
      tokens: REDACTED,
      list: [{ secret: REDACTED }],
    });
  });

  it('bounds depth, arrays and strings', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain('[nested too deep]');
    const long = redact(new Array(150).fill(1)) as unknown[];
    expect(long).toHaveLength(101);
    expect(long[100]).toBe('[50 more]');
    expect((redact('x'.repeat(5000)) as string).length).toBeLessThan(2010);
  });

  it('masks secrets inside free text', () => {
    expect(redactString('Authorization: Bearer abcdefgh12345678')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactString('key alk_ab12cd34_secretsecret leaked')).toBe(`key ${REDACTED} leaked`);
    expect(redactString('card 4111 1111 1111 1111 declined')).toBe(`card ${REDACTED} declined`);
    // Not a card: fails the Luhn check, or is an epoch-millisecond timestamp.
    expect(redactString('order 4111111111111112')).toBe('order 4111111111111112');
    expect(redactString('at 1760870400000')).toBe('at 1760870400000');
  });
});

describe('redactString', () => {
  it('does not shorten text (callers apply their own limits)', () => {
    expect(redactString('x'.repeat(9000))).toHaveLength(9000);
  });
});
