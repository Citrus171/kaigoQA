# syntax=docker/dockerfile:1
# @hybrid/web（Next.js standalone）コンテナ。
#   build context = リポジトリ root:
#     docker build -f apps/web/Dockerfile -t hybrid-web:dev .
FROM node:22-slim AS base
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# --- build（Next standalone 出力）---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @hybrid/web

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# モノレポ standalone: outputFileTracingRoot=repo root のため app 構造ごと出力される。
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# ※ apps/web/public は現状存在しないため COPY しない（生成時に追加すること）。
EXPOSE 3000
USER node
# server.js は standalone レイアウト上 apps/web/ 配下に生成される。
# env: API_ORIGIN（api Service URL。BFFプロキシが参照）。
CMD ["node", "apps/web/server.js"]
