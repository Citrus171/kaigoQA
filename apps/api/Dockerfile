# syntax=docker/dockerfile:1
# @hybrid/api（Hono / Node エントリ src/dev.ts）コンテナ。
#   build context = リポジトリ root（npm workspaces 全体が必要）:
#     docker build -f apps/api/Dockerfile -t hybrid-api:dev .
# 本番起動は tsx 実行: shared/api とも TS ソース直参照(exports=src/*.ts)のため、
# tsc バンドルより tsx 実行が確実（paths(@/*) と @hybrid/shared を実行時解決）。
FROM node:22-slim AS base
WORKDIR /app

# --- deps: workspace マニフェストだけ先にコピーして install をキャッシュ ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
# 稼働ビルド識別子。CI が --build-arg GIT_SHA=<short> を渡し、/health が返す（デプロイ反映確認用）。
# build 時に焼き込む＝image に対し不変。未指定時は app 側で "dev" にフォールバック。
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
# --chown: リポジトリ側ファイルが group-only 権限のため、USER node が読めるよう所有者を移す
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared ./packages/shared
COPY --chown=node:node apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 8787
USER node
# env は実行時注入（DATABASE_URL/JWT_SECRET 等）。readiness は GET /health（DB疎通込み）。
CMD ["npm", "run", "start"]
