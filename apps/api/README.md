# functest-hono — Workers ネイティブな Hono 構築

`functest-freelance`（Next.js 一体型）に対し、**Cloudflare Workers ネイティブ**を狙った別構成。
Hono を中心に据え、**ローカルは Node ランタイム + docker Postgres**、**デプロイは Workers + Neon** に
env で分岐させる二刀流。Todo CRUD・認証・**認可（RBAC + Authorizer 抽象）**・ジョブ・テストは
functest-freelance と同等のスコープ。

## スタック

| 層 | 採用 | 備考 |
|---|---|---|
| Web | **Hono** | Workers ネイティブ。Node でも同一アプリが動く |
| 検証 | Zod + `@hono/zod-validator` | 単一の真実（`src/lib/schemas.ts`） |
| ORM | **Drizzle ORM** | エッジ対応。node-postgres / neon-http を分岐 |
| DB | PostgreSQL | ローカル=docker / 本番=Neon serverless |
| 認証 | JWT（`hono/jwt`）+ WebCrypto(PBKDF2) | **node:crypto を避け Workers 互換**にした |
| 認可 | `src/authz.ts` Authorizer + RBAC | Phase1 直参照 → Phase2 ReBAC 差し替え可 |
| ジョブ | `src/jobs.ts`（差し替え点） | 本番は Cloudflare Queues / Inngest |
| テスト | Vitest（`app.request()` で実DB） | 認可境界を検証 |

## ランタイム分岐（キモ）

```
            createApp(resolvers)  ← ルート定義は共通
           /                     \
  src/dev.ts (Node)            src/index.ts (Workers)
  nodeDb: node-postgres(TCP)   neonDb: neon-http(HTTP)
  docker Postgres :5435        Neon serverless
```

- `getDb` / `getJwtSecret` を注入する `createApp` により、**同じルートを Node と Workers で共有**。
- Workers は生TCP不可なので Neon の HTTP ドライバ。ローカルは docker Postgres に node-postgres。
- `pg` は `src/db/node.ts` だけが import するため、**Workers バンドルに pg は入らない**。

## ローカル起動

```bash
cd functest-hono
npm install
npm run db:up                 # docker Postgres（ホスト :5435）
npm run db:push               # スキーマ反映（Drizzle）
npm run db:seed               # demo/admin ユーザー投入
npm run dev                   # http://localhost:8787（Node ランタイム）
```

ログイン用: `demo@example.com`（user） / `admin@example.com`（admin） / password: `password`

### API 例

```bash
# ログイン → JWT
TOKEN=$(curl -s -X POST localhost:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"password"}' | jq -r .token)

curl localhost:8787/todos -H "Authorization: Bearer $TOKEN"
curl -X POST localhost:8787/todos -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"買い物"}'
curl localhost:8787/health
```

| メソッド | パス | 認可 |
|---|---|---|
| POST | `/auth/login` | public |
| GET/POST | `/todos` | 要認証（自分の分のみ） |
| PATCH | `/todos/:id` | 所有チェック（WHERE 句 = Phase1 DbAuthorizer） |
| PATCH | `/todos/:id/set-done` | Authorizer（所有者 or admin） |
| DELETE | `/todos/:id` | 所有チェック |
| GET | `/admin/stats` | admin role（RBAC） |
| GET | `/health` | public（DB 疎通込み） |

## テスト

```bash
# 事前に test 用 DB を用意（初回のみ）
docker exec fh-db psql -U app -d functest_hono -c "CREATE DATABASE functest_hono_test;"
npm run db:test:push
npm test                      # Vitest（認可境界・RBAC を実DBで検証）
npm run check                 # typecheck + test
```

- `test/*.test.ts` は Hono の `app.request()` で**本物のルート + Drizzle + Postgres**を叩く。
- 検証内容: 未認証=401 / 所有外の更新・削除=404 / `set-done` の他人=403 / admin の横断集計と全許可 / Zod=400。
- `TEST_DATABASE_URL` で接続先を上書き可能（CI 用）。

## Cloudflare Workers へのデプロイ

```bash
wrangler secret put DATABASE_URL   # Neon の接続文字列
wrangler secret put JWT_SECRET
npm run cf:deploy                  # wrangler deploy（src/index.ts がエントリ）
```

- `wrangler.toml` で `compatibility_flags = ["nodejs_compat"]`、`[vars] DB_DRIVER = "neon"`。
- DB は Neon（または Hyperdrive 経由の Postgres）。`DATABASE_URL` を Neon の文字列にするだけ。
- ジョブを本番運用するなら `src/jobs.ts` を Cloudflare Queues / Inngest に差し替える。

## functest-freelance との違い

| | functest-freelance | functest-hono |
|---|---|---|
| 主眼 | 案件数最大（Next.js 一体型） | Workers ネイティブ |
| Web/Router | Next.js App Router | Hono |
| API | tRPC | Hono ルート + zod-validator |
| ORM | Prisma | Drizzle |
| 認証 | Auth.js | JWT + WebCrypto（Workers 互換） |
| ホスト | Vercel + Neon | Cloudflare Workers + Neon |
| 共通 | Zod / 認可(Authorizer+RBAC) / 認可境界テスト | 同左（移植） |
