// A small Express API wired to apiloupe the way most Node apps would be:
// the middleware records every request, pino's lines go to stdout as usual
// and to apiloupe as well, and shutdown flushes what is still queued.
//
//   APILOUPE_ENDPOINT=http://localhost:8080 APILOUPE_KEY=alk_... node index.js
//
// Add TRAFFIC=1 to have it call itself a few times a second.
const { randomUUID } = require('node:crypto');
const express = require('express');
const pino = require('pino');
const { createApiloupe } = require('@apiloupe/node');

const apiloupe = createApiloupe({
  endpoint: process.env.APILOUPE_ENDPOINT,
  key: process.env.APILOUPE_KEY,
  service: 'example-shop',
});

const logger = pino(
  { timestamp: pino.stdTimeFunctions.isoTime },
  // `requests: false`: the middleware below already records requests.
  pino.multistream([
    { stream: process.stdout },
    { stream: apiloupe.pinoStream({ requests: false }) },
  ]),
);

const app = express();
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  req.log = logger.child({ requestId: req.id });
  next();
});
app.use(apiloupe.express({ skip: (req) => req.url === '/health' }));
app.use(express.json());

const products = new Map([
  ['1', { id: '1', name: 'Coffee', price: 4 }],
  ['2', { id: '2', name: 'Tea', price: 3 }],
]);

app.get('/health', (_req, res) => res.send('ok'));
app.get('/products', (_req, res) => res.json([...products.values()]));
app.get('/products/:id', (req, res) => {
  const product = products.get(req.params.id);
  if (!product) {
    req.log.warn({ productId: req.params.id }, 'unknown product');
    return res.status(404).json({ error: 'not found' });
  }
  res.json(product);
});
app.post('/checkout', (req, res) => {
  if (Math.random() < 0.1) throw new Error('payment gateway timed out');
  req.log.info({ items: (req.body && req.body.items) || 0 }, 'order placed');
  res.status(201).json({ ok: true });
});

// Errors are logged through pino, which apiloupe receives already. An app
// that does not log its errors would add `app.use(apiloupe.expressErrorHandler())`
// here instead.
app.use((err, req, res, _next) => {
  req.log.error({ err }, 'request failed');
  res.status(500).json({ error: 'internal error' });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  logger.info({ port, apiloupe: apiloupe.enabled }, 'example shop listening');
});

if (process.env.TRAFFIC) {
  const base = `http://127.0.0.1:${port}`;
  const calls = [
    () => fetch(`${base}/products`),
    () => fetch(`${base}/products/${Math.ceil(Math.random() * 3)}`),
    () =>
      fetch(`${base}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: 2 }),
      }),
  ];
  setInterval(() => {
    calls[Math.floor(Math.random() * calls.length)]().catch(() => undefined);
  }, 250).unref();
}

async function stop(signal) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await apiloupe.shutdown();
  process.exit(0);
}
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
