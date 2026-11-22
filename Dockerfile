# Stage 1: Build frontend + install deps (bun-first)
FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Stage 2: Runtime (bun, tanpa kredensial bake)
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY server/ ./server/
COPY --from=frontend /app/dist ./dist/

EXPOSE 3001
ENV NODE_ENV=production
CMD ["bun", "server/index.ts"]
