# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Next.js フロント + Hono API（Cloudflare Workers / Node 二刀流）の **ハイブリッド雛形**。
既存2repo（`functest-freelance`=フロント / `functest-hono`=API）をコピー再構成したもの。npm workspaces のモノレポ。

- `apps/api`（`@hybrid/api`）: Hono + Drizzle + JWT(WebCrypto)。Workers/Node 両対応。
- `apps/web`（`@hybrid/web`）: Next.js（フロント専用。tRPC/Prisma/Auth.js/DB は撤去済み）。
- `packages/shared`（`@hybrid/shared`）: Zod スキーマ（API検証 + RHF で共有 = 単一の真実）。

> 設計の一次情報は `PROGRESS.md`（計画・ハマり所）と `README.md`。
> `docs/` 配下（gitignore対象・非追跡）に AIルーティングPoC等の設計メモあり。

## コマンド

ルートから（npm workspaces 経由）:

```bash
npm install
npm run db:up        # api の docker Postgres を起動（:5435）
npm run db:push      # Drizzle スキーマ反映
npm run db:seed      # demo/admin ユーザー投入

# 2プロセス起動（別ターミナル）
npm run dev:api              # Hono(Node) :8787
PORT=3456 npm run dev:web    # Next :3456（API_ORIGIN=http://localhost:8787）

npm run typecheck    # api + web 両方
npm run test:api     # api の Vitest（認可境界・RBAC、実DB使用）
npm run build:web    # Next build
```

API ワークスペース内（`apps/api`）で直接叩く場合:

```bash
npm run test -w @hybrid/api -- -t "テスト名"   # 単一テスト（vitest -t でフィルタ）
npm run db:test:push -w @hybrid/api            # テスト用DB(functest_hono_test)へスキーマ反映
npm run cf:dev -w @hybrid/api                  # wrangler dev（Workers ローカル）
npm run cf:deploy -w @hybrid/api               # Workers デプロイ
```

ログイン: `demo@example.com`(user) / `admin@example.com`(admin) / `password`
ポート: api=:8787、web=:3000（占有時は `PORT` 変更）、docker Postgres=:5435

## アーキテクチャ（big picture）

### 1. API のランタイム二刀流（最重要）

ルート定義は `apps/api/src/app.ts` の `createApp(resolvers)` に集約され、**db と jwtSecret の解決方法を注入**することで同一ルートを2ランタイムで共有する:

- `src/index.ts` = **Workers エントリ**。`c.env` のバインディングから解決、Neon serverless(HTTP) ドライバ。`pg` は import しない。
- `src/dev.ts` = **Node エントリ**。`process.env` から解決、node-postgres(TCP) で docker Postgres へ。
- DB ドライバは `src/db/neon.ts`（prod）/ `src/db/node.ts`（dev）に分離。

新しいルートを足すときは `createApp` のチェーンに `.route()` で追加すること（下記の型推論の制約に従う）。

### 2. 越境の型（tRPC 代替）

`apps/api/src/index.ts` が `export type AppType = typeof app`。web は `apps/web/src/lib/api.ts` の `hc<AppType>("/api")` で型付きクライアントを得る。

- **制約**: Hono RPC はルートを**メソッドチェーンで定義**しないと型が蓄積しない。`app.ts` と `routes/*` は必ずチェーン化する（バラした瞬間 hc 側が `unknown` になる）。

### 3. 認証フロー（案Y = Next BFF プロキシ）

`apps/web/src/app/api/[...path]/route.ts` が全API呼び出しを中継する:

- httpOnly cookie `session`(JWT) を読み、`Authorization: Bearer` に変換して `API_ORIGIN`(Hono) へ転送。
- **ログインだけ特例**: `auth/login` は Hono の `{token}` を受けて **httpOnly cookie に格納**し、token はクライアントに返さない（`{ok:true}`）。→ JS からトークンに触れない（XSS耐性）。
- ログアウトは `apps/web/src/app/api/logout/route.ts` で cookie 削除。
- 認可（RBAC）は **api 側のみ**。web は DB を持たない。

### 4. モノレポ固有のハマり所（PROGRESS.md より）

- web の typecheck が api 源の `@/` を解決できない → web の tsconfig の `@/*` に `../api/src/*` フォールバックを追加済み。触るとき注意。
- WebCrypto の `BufferSource` 型が lib 差で衝突（api=ES2022 / web=DOM）→ DOM 型名を使わず ArrayBuffer 裏付けの Uint8Array にコピーして両対応している。

## デプロイ

- api → Cloudflare Workers: `apps/api` で `wrangler secret put DATABASE_URL`(Neon) / `JWT_SECRET` → `npm run cf:deploy`。
- web → Vercel/Pages: 環境変数 `API_ORIGIN` を Worker の URL に設定。
