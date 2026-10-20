// Compiled by `pnpm typecheck`, never run: the SDK's handlers must slot into
// Express's own types without casts.
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import pino from 'pino';
import { createApiloupe } from '../src/index.js';

const apiloupe = createApiloupe({
  endpoint: process.env.APILOUPE_ENDPOINT,
  key: process.env.APILOUPE_KEY,
});
const app = express();
app.use(apiloupe.express({ skip: (req) => req.url === '/health' }));
app.use(apiloupe.expressErrorHandler());

export const handler: RequestHandler = apiloupe.express();
export const errorHandler: ErrorRequestHandler = apiloupe.expressErrorHandler();
export const logger = pino(
  {},
  pino.multistream([{ stream: process.stdout }, { stream: apiloupe.pinoStream() }]),
);
export const direct = pino({}, apiloupe.pinoStream());
