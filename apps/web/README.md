# functest-freelance — 案件獲得最適化スタックの動作確認 Todo アプリ

`functest`（Hono / Kysely / ts-rest / pg-boss / Zitadel）と**同じ Todo アプリ**を、
2026年のフリーランス案件数を最大化するスタックで作り直した雛形。**ローカル完結**（外部 SaaS 不要）。

## スタック

| 層 | 採用 | functest での対応 |
|---|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript | React + Vite + TanStack Router |
| 状態 | TanStack Query（tRPC 統合） | TanStack Query |
| フォーム | react-hook-form + Zod | 同じ |
| UI | shadcn/ui 風 + Tailwind CSS v4 | shadcn/ui |
| Backend | Next.js Route Handlers | Hono |
| API 契約 | tRPC（Zod = 単一の真実） | ts-rest |
| DB | Prisma + PostgreSQL | Kysely + PostgreSQL |
| 認証 | Auth.js (NextAuth) Credentials | Zitadel(OIDC) |
| ジョブ | Inngest（ローカル dev server） | pg-boss |
| テスト | Vitest（単体）+ Playwright（E2E） | Playwright |
| Ops | Renovate | Renovate |

> 本番想定では DB=Neon、ホスティング=Vercel、Queue=Inngest Cloud。
> この雛形はそれらをローカル（docker Postgres / Inngest dev server）に置き換えている。

## 各ツールの確認ポイント

| ツール | どこで動くか |
|---|---|
| Zod | `src/lib/schemas.ts` の1スキーマを tRPC input・RHF resolver・テストで共有 |
| tRPC | `src/server/routers/todo.ts`（実装）↔ `src/lib/trpc/react.tsx`（型付きクライアント） |
| Prisma | `src/server/db.ts` + `prisma/schema.prisma` の型付き CRUD |
| Auth.js | `src/auth.ts`（Credentials）→ tRPC `protectedProcedure` で `/api/trpc` を保護 |
| Inngest | Todo 作成時に `todo/created` を送信 → `src/inngest/functions.ts` がログ出力 |
| TanStack Query | `src/app/todos/todo-list.tsx` の取得・mutation・invalidate |
| react-hook-form | 追加フォーム・ログインフォーム（zodResolver） |
| 認可(Authorizer) | `src/server/authz.ts`。Phase1=RBAC直参照。`adminProcedure`/`requireOwned` で利用 |

## 認証(authn)と認可(authz)の設計

認証ライブラリ（Auth.js）は交換可能なコモディティとして薄く扱い、価値の出る**認可**を抽象化して設計している。

- **所有チェック（Phase1 / DbAuthorizer 相当）**: `todo.toggle` などは Prisma の `where: { id, userId }` で DB 層に所有を強制（防御の最終線）。
- **object-level 認可**: `todo.setDone` は `ctx.authz.requireOwned(todo.userId)` で判定（所有者 or admin が可）。
- **role 認可（RBAC）**: `adminProcedure` が `ctx.authz.requireRole("admin")` を要求。`admin.stats` は全ユーザー横断集計で admin 限定。
- **差し替え前提**: `Authorizer` インターフェースにより、Phase2 で OpenFGA 等の ReBAC 実装へ呼び出し側無変更で移行できる。

これらの境界は `src/server/__tests__/*.integration.test.ts` で **赤→緑**の統合テスト（本物の router + Prisma + Postgres）として固定している。

### seed 済みアカウント

| email | role | 用途 |
|---|---|---|
| `demo@example.com` | user | 通常操作 |
| `admin@example.com` | admin | `admin.stats` / 横断操作 |

（いずれも password: `password`）

## 起動手順

```bash
cd functest-freelance
npm install
npx playwright install chromium   # E2E を回す場合のみ

cp .env.example .env              # 既に .env は同梱済み（dev 用ダミー値）
npm run db:up                     # PostgreSQL を docker で起動（ホスト :5433）
npm run db:push                   # スキーマを反映
npm run db:seed                   # demo@example.com / password を投入

npm run dev                       # http://localhost:3000
```

ログイン: `demo@example.com` / `password`（ログイン画面に既定入力済み）。

### Inngest のジョブを確認する（任意）

別ターミナルで dev server を起動すると、Todo 作成時のジョブ実行が可視化される。

```bash
npm run inngest:dev               # http://localhost:8288 にダッシュボード
```

> dev server を起動しなくてもアプリは動く（`inngest.send` は失敗してもアプリを止めない設計）。
> 起動していれば `[inngest] todo created: ...` が dev server 側で実行・記録される。

## テスト

```bash
npm run db:up                     # Postgres 起動
npm run db:test:push              # テスト用 DB(functest_test) にスキーマ反映（初回/スキーマ変更時）
npm test                          # Vitest（単体 + 認可境界の統合テスト）
npm run check                     # typecheck + test をまとめて実行（CI と同じ入口）
npm run e2e                       # Playwright（要 db:up + db:push + db:seed）
```

- 単体: `src/lib/schemas.test.ts`（Zod 境界値・パスワードハッシュ）
- 統合: `src/server/__tests__/*.integration.test.ts`。tRPC `createCaller` で**本物の router + Prisma + Postgres**を叩き、所有/RBAC の**認可境界**を検証する。外部キュー(Inngest)のみ境界としてモック。
- テスト用 DB は本番/開発の `DATABASE_URL` と分離（`functest_test`）。`TEST_DATABASE_URL` で上書き可能（CI はこれで Postgres service を指す）。

## CI（GitHub Actions）

`.github/workflows/ci.yml` が push / PR で **Postgres service を立てて** `prisma generate → db:test:push → typecheck → test → build` を実行する。

## 運用性

- `GET /api/health`: DB 疎通まで確認する readiness/liveness probe。正常 200 / DB ダウン 503。
- マイグレーション: 現状は `db push`。本番運用では `prisma migrate`（履歴管理）へ移行する（`db:migrate` / `db:deploy` script を用意済み）。

## 本番（Vercel + Neon + Inngest Cloud）へ寄せる場合

| ローカル | 本番 |
|---|---|
| docker Postgres (`db:up`) | Neon（`DATABASE_URL` を差し替え） |
| `next dev` | Vercel デプロイ |
| Inngest dev server | Inngest Cloud（`INNGEST_EVENT_KEY` / `SIGNING_KEY` を実値に） |
| Credentials 認証 | Auth.js に OAuth provider を追加（GitHub/Google 等） |

コードは環境変数の差し替えのみで移行できる構成にしてある。
