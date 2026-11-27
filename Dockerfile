FROM node:22-slim

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy runtime source and UI assets
COPY src ./src
COPY ui ./ui

# Prepare non-root data directory for persisted config.json (0600); keep /app read-only to node
RUN mkdir -p /data && chown -R node:node /data

USER node

ENV NODE_ENV=production \
    MCP_SHELF_MODE=remote \
    MCP_SHELF_HOST=0.0.0.0 \
    MCP_SHELF_PORT=8787 \
    MCP_SHELF_HOME=/data

EXPOSE 8787

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MCP_SHELF_PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/main.mjs"]
