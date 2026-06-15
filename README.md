# functest-hybrid — Next フロント + Hono API on Workers

既存2repo（`functest-freelance`=フロント / `functest-hono`=API）を**コピー再構成**したハイブリッド雛形。
接続は **案Y：Next の BFF プロキシ（同一オリジン・httpOnly cookie）**。

> 詳細な設計判断・進捗・ハマり所は **`PROGRESS.md`**（一次情報）。

## 構成（npm workspaces）

```
functest-hybrid/
├─ apps/
│  ├─ api/   Hono + Drizzle + JWT(WebCrypto)（= functest-hono ベース。Workers/Node 二刀流）
│  └─ web/   Next.js（フロント専用。tRPC/Prisma/Auth.js/DB は撤去）
└─ packages/
   └─ shared/  Zod スキーマ（api 検証 + web RHF で共有）
```

- **越境の型**：api が `export type AppType = typeof app` → web が `hc<AppType>` で型付きクライアント（tRPC 代替）。
- **認証フロー（案Y）**：web の `app/api/[...path]/route.ts`(BFF) が cookie `session`(JWT) を `Authorization: Bearer` に変換して `API_ORIGIN`(Hono) へ転送。`auth/login` は特例で Hono の token を **httpOnly cookie に格納**（JSへ非露出）。`/api/logout` で cookie 削除。
- **DB は api 側のみ**（Drizzle / local=docker Postgres :5435 / prod=Neon）。

## ローカル起動

```bash
npm install
npm run db:up        # api の docker Postgres（:5435）
npm run db:push      # スキーマ反映（Drizzle）
npm run db:seed      # demo/admin ユーザー

# 2プロセス起動
npm run dev:api      # Hono(Node) :8787
PORT=3456 npm run dev:web   # Next :3456（API_ORIGIN=http://localhost:8787）
```

ログイン: `demo@example.com`(user) / `admin@example.com`(admin) / `password`

## 検証コマンド

```bash
npm run typecheck            # api + web
npm run test:api             # 認可境界・RBAC（実DB）
npm run build:web            # Next build
```

## デプロイ

- api → Cloudflare Workers：`apps/api` で `wrangler secret put DATABASE_URL`(Neon) / `JWT_SECRET` → `npm run cf:deploy`。
- web → Vercel/Pages：`API_ORIGIN` を Worker の URL に設定。

## どの repo から来たか

| | 由来 | 主な変更 |
|---|---|---|
| apps/api | functest-hono | `AppType` export、ルートをチェーン化（hc 型推論） |
| apps/web | functest-freelance | バックエンド全撤去、`hc`＋cookie ログインに置換、proxy 追加 |
| packages/shared | 両者の Zod | 集約して単一の真実に |
