import { describe, expect, it } from 'vitest';
import { groupingFor, normalizeMessage, parseStack, shortPath } from '../src/index.js';

const STACK = `TypeError: Cannot read properties of null (reading 'id')
    at closeSession (/app/src/services/sessionService.js:212:31)
    at async reconcile (/app/src/jobs/reconciler.js:88:7)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at new Promise (<anonymous>)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;

describe('parseStack', () => {
  it('reads V8 frames and tells app code from dependencies and the runtime', () => {
    const frames = parseStack(STACK);
    expect(frames).toHaveLength(5);
    expect(frames[0]).toEqual({
      fn: 'closeSession',
      file: '/app/src/services/sessionService.js',
      line: 212,
      column: 31,
      inApp: true,
    });
    expect(frames[1]).toMatchObject({ fn: 'reconcile', inApp: true });
    expect(frames[2]).toMatchObject({ fn: 'Layer.handle', inApp: false });
    expect(frames[3]).toMatchObject({
      fn: 'Promise',
      file: '<anonymous>',
      line: null,
      inApp: false,
    });
    expect(frames[4]).toMatchObject({ inApp: false });
  });

  it('handles frames without a function, file URLs and eval', () => {
    const frames = parseStack(
      [
        '    at /app/index.js:3:9',
        '    at file:///app/src/main.mjs:10:2',
        '    at eval (eval at run (/app/src/sandbox.js:5:3), <anonymous>:1:1)',
      ].join('\n'),
    );
    expect(frames.map((f) => [f.fn, f.file, f.line])).toEqual([
      [null, '/app/index.js', 3],
      [null, 'file:///app/src/main.mjs', 10],
      ['eval', '/app/src/sandbox.js', 5],
    ]);
  });

  it('returns nothing for text that is not a stack', () => {
    expect(parseStack('Traceback (most recent call last):\n  File "x.py", line 1')).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe('shortPath', () => {
  it.each([
    ['/app/src/services/sessionService.js', 'services/sessionService.js'],
    ['/home/deploy/releases/42/src/services/sessionService.js', 'services/sessionService.js'],
    ['C:\\soffa\\src\\services\\sessionService.js', 'services/sessionService.js'],
    ['file:///app/dist/main.3f2a9c1e.js?v=1', 'dist/main.js'],
    ['index.js', 'index.js'],
  ])('%s → %s', (input, expected) => {
    expect(shortPath(input)).toBe(expected);
  });
});

describe('normalizeMessage', () => {
  it.each([
    ['user 42 not found', 'user <n> not found'],
    ['order 0f8fad5b-d9cb-469f-a165-70867728950e failed', 'order <uuid> failed'],
    ['connect ECONNREFUSED 10.0.0.12:3306', 'connect ECONNREFUSED <ip>'],
    ['no account for sam@example.com', 'no account for <email>'],
    [
      "Cannot read properties of null (reading 'id')",
      "Cannot read properties of null (reading 'id')",
    ],
    ["plate 'B12345' unknown", 'plate <str> unknown'],
    ['blob 5f2b9c0e1a7d4e3f9a8b missing', 'blob <hex> missing'],
    ['  many   spaces  ', 'many spaces'],
  ])('%s', (input, expected) => {
    expect(normalizeMessage(input)).toBe(expected);
  });
});

describe('groupingFor', () => {
  const base = { service: 'api', message: 'handler failed', errorType: 'TypeError' };

  it('groups by type and app frames, ignoring line numbers, paths and the message', () => {
    const a = groupingFor({ ...base, errorMessage: "reading 'id'", errorStack: STACK });
    const moved = groupingFor({
      ...base,
      errorMessage: "reading 'name'",
      errorStack: STACK.replace(':212:31', ':230:9').replaceAll('/app/src/', '/srv/v2/src/'),
    });
    expect(moved.key).toBe(a.key);
    expect(a.culprit).toBe('closeSession (services/sessionService.js)');
    expect(a.title).toBe("TypeError: reading 'id'");
    expect(a.key).toContain('at reconcile (jobs/reconciler.js)');
    // Dependency frames are left out when the app has frames of its own.
    expect(a.key).not.toContain('express');
  });

  it('splits by error type, service and code location', () => {
    const a = groupingFor({ ...base, errorStack: STACK });
    expect(groupingFor({ ...base, errorType: 'RangeError', errorStack: STACK }).key).not.toBe(
      a.key,
    );
    expect(groupingFor({ ...base, service: 'worker', errorStack: STACK }).key).not.toBe(a.key);
    expect(
      groupingFor({ ...base, errorStack: STACK.replace('closeSession', 'openSession') }).key,
    ).not.toBe(a.key);
  });

  it('without a stack, groups by the masked message', () => {
    const a = groupingFor({
      service: 'api',
      message: 'Request error',
      errorMessage: 'lock wait timeout on row 17',
    });
    const b = groupingFor({
      service: 'api',
      message: 'Request error',
      errorMessage: 'lock wait timeout on row 9001',
    });
    const c = groupingFor({
      service: 'api',
      message: 'Request error',
      errorMessage: 'pool is closed',
    });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.title).toBe('lock wait timeout on row 17');
    expect(a.culprit).toBeNull();
  });

  it('falls back to the log message, then a placeholder', () => {
    expect(groupingFor({ service: '', message: 'payment failed for order 5' }).title).toBe(
      'payment failed for order 5',
    );
    expect(groupingFor({ service: '', message: '' }).title).toBe('(no message)');
  });

  it('uses dependency frames when there are no app frames at all', () => {
    const g = groupingFor({
      service: 'api',
      message: 'x',
      errorType: 'Error',
      errorStack:
        'Error: x\n    at Socket.emit (node:events:519:28)\n    at Parser.parse (/app/node_modules/pg/lib/parser.js:10:3)',
    });
    expect(g.culprit).toBe('Socket.emit (node:events)');
  });
});
