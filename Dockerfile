# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim

# ── build ─────────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/core/package.json packages/core/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY plugins/truenas/package.json plugins/truenas/
COPY plugins/seerr/package.json plugins/seerr/
COPY plugins/homeassistant/package.json plugins/homeassistant/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY plugins plugins
RUN pnpm -r build

# ── runtime ───────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    MCP_PORT=8080 \
    ADMIN_PORT=8081 \
    ADMIN_UI_DIR=/app/packages/admin-ui/dist \
    CORE_PLUGINS_DIR=/app/plugins
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/packages/plugin-sdk/package.json packages/plugin-sdk/
COPY --from=build /app/packages/plugin-sdk/dist packages/plugin-sdk/dist
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/drizzle packages/core/drizzle
COPY --from=build /app/packages/admin-ui/package.json packages/admin-ui/
COPY --from=build /app/packages/admin-ui/dist packages/admin-ui/dist
COPY --from=build /app/plugins/truenas/package.json /app/plugins/truenas/manifest.json plugins/truenas/
COPY --from=build /app/plugins/truenas/dist plugins/truenas/dist
COPY --from=build /app/plugins/seerr/package.json /app/plugins/seerr/manifest.json plugins/seerr/
COPY --from=build /app/plugins/seerr/dist plugins/seerr/dist
COPY --from=build /app/plugins/homeassistant/package.json /app/plugins/homeassistant/manifest.json plugins/homeassistant/
COPY --from=build /app/plugins/homeassistant/dist plugins/homeassistant/dist
RUN pnpm install --frozen-lockfile --prod \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# isolated-vm requires --no-node-snapshot on Node >= 20.
CMD ["node", "--no-node-snapshot", "packages/core/dist/main.js"]
