# @apiloupe/node

Send a Node.js API's requests, logs and errors to
[apiloupe](https://github.com/emaalouf/apiloupe), the self-hosted request and
error dashboard.

- **Express middleware:** every request with its route, status and duration.
- **pino stream:** every log line, alongside wherever your logs go now.
- **Errors:** with stack traces, linked to the request they happened in.
- **No dependencies.** CommonJS and ESM, Node 20+. Safe in single-file
  executables (`pkg`): it uses no worker threads.

## Install

```sh
npm install @apiloupe/node
```

## Use

```js
const { createApiloupe } = require('@apiloupe/node'); // or import

const apiloupe = createApiloupe({
  endpoint: process.env.APILOUPE_ENDPOINT, // https://apiloupe.example.com
  key: process.env.APILOUPE_KEY, // alk_… from the project's settings
  service: 'orders-api',
});

app.use(apiloupe.express());
// … your routes …
app.use(apiloupe.expressErrorHandler()); // before your own error handler

process.on('SIGTERM', async () => {
  await apiloupe.shutdown(); // sends what is still queued
  process.exit(0);
});
```

Without an `endpoint` and `key` the client does nothing at all, so the same
code runs in development and in tests.

### pino

```js
const logger = pino(
  options,
  pino.multistream([{ stream: process.stdout }, { stream: apiloupe.pinoStream() }]),
);
```

Log lines keep going to stdout and are sent too. If your app already writes
one log line per request (pino-http, or an access log of its own), the pino
stream sends those as requests and you do not need `express()`. If you use
both, pass `apiloupe.pinoStream({ requests: false })` so requests are not
counted twice.

A line sent live and the same line imported later from your log files (with
`apiloupe-import`) are the same event; importing a period you already shipped
adds nothing.

### Sampling

For busy apps, `sampleRate: 0.1` sends one in ten successful requests and logs
below warn. Errors, warnings and failed requests are always sent, and the
dashboard counts each sampled event as ten, so totals and charts stay right.
Which lines are kept depends only on their content: importing the same logs
later with `apiloupe-import --sample-rate 0.1` keeps the same ones, so nothing
is counted twice.

### By hand

```js
apiloupe.log('warn', 'cache miss storm', { attrs: { hitRate: 0.12 } });
apiloupe.captureException(err, { requestId: req.id });
```

## What it promises

- **It never throws into your code and never blocks a request.** Recording a
  request costs a few microseconds; serialising, compressing and sending
  happen later, in batches, in the background.
- **Memory is bounded.** If apiloupe is slow or down, events wait in a queue
  of `maxQueue` (10 000); past that the oldest are dropped and counted
  (`apiloupe.stats()`).
- **It does not hold your process open.** A script that finishes exits; the
  client makes one short attempt (2 s) to send what is queued first.
- **Retries are polite.** `429` and `503` are retried after `Retry-After`;
  network errors back off up to a minute. Refusals that will not change (a
  revoked key) drop the batch and say so.
- **Privacy by default.** Query strings never leave your app; bodies, headers
  and IPs are sent only with `captureBodies: true`, and keys that look secret
  (`password`, `token`, `authorization`, …) are masked either way.

## Options

| Option            | Default        | Meaning                                                      |
| ----------------- | -------------- | ------------------------------------------------------------ |
| `endpoint`, `key` | none           | Where to send. Without both, nothing is sent.                |
| `service`         | none           | Names this app when several share a project.                 |
| `captureBodies`   | `false`        | Also send bodies, query strings, headers and IPs (masked).   |
| `sampleRate`      | `1`            | Share of successful requests and routine logs to send (0–1). |
| `maxQueue`        | `10000`        | Events held while sending is slow or failing.                |
| `batchSize`       | `500`          | Events per request (at most 1000).                           |
| `flushIntervalMs` | `2000`         | How often queued events are sent.                            |
| `timeoutMs`       | `10000`        | Per request.                                                 |
| `onError`         | a rare warning | Called with sending problems; `false` for silence.           |
| `flushOnExit`     | `true`         | Try to send what is queued when the event loop empties.      |

`express({ requestId, skip })`: how to find a request's id (default `req.id`,
then the `x-request-id` header) and which requests to leave out.

## License

MIT
