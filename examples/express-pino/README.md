# Example: Express + pino

A small API that sends its requests, logs and errors to the Soffa API Logs
Dashboard with [`@apiloupe/node`](../../packages/sdk-node).

```sh
pnpm install && pnpm build          # from the repository root
cd examples/express-pino
APILOUPE_ENDPOINT=http://localhost:8080 APILOUPE_KEY=alk_... TRAFFIC=1 node index.js
```

`TRAFFIC=1` makes it call itself a few times a second. About one checkout in
ten fails, so the dashboard has errors to show, each linked to its request.

Without `APILOUPE_ENDPOINT` and `APILOUPE_KEY` it runs normally and sends
nothing.
