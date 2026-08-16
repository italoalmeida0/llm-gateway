# ===== Build stage: bundle the dashboard SPA =====
FROM oven/bun:1-alpine AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY plugins ./plugins
COPY build.ts tsconfig.json ./
COPY web ./web
RUN bun ./build.ts

# ===== Runtime stage: server + built assets =====
FROM oven/bun:1-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server ./server
COPY --from=webbuild /app/dist ./dist

# Run as a dedicated non-root user (least privilege). /data holds the DB and
# the dev secret, so it is owned by that user and mounted as a volume.
RUN mkdir -p /data \
    && addgroup -S gateway && adduser -S -G gateway gateway \
    && chown -R gateway:gateway /app /data
USER gateway

# /data holds gateway.db + .secret -> mount a volume to persist it
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server/index.ts"]
