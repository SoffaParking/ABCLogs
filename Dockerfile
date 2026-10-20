# syntax=docker/dockerfile:1
#
# One image: the API server, which also serves the built dashboard, plus the
# two command-line tools (`apiloupe-server` for accounts and migrations,
# `apiloupe-import` for log files). Multi-arch (amd64 / arm64) through
# `docker buildx build --platform linux/amd64,linux/arm64`.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r build \
 && pnpm deploy --filter @apiloupe/server --prod /out/app \
 && pnpm deploy --filter @apiloupe/importer --prod /out/importer \
 && cp -R packages/ui/dist /out/app/public

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
COPY --from=build --chown=node:node /out/importer /importer
RUN chmod +x /app/dist/cli.js /importer/dist/cli.js \
 && ln -s /app/dist/cli.js /usr/local/bin/apiloupe-server \
 && ln -s /importer/dist/cli.js /usr/local/bin/apiloupe-import
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
