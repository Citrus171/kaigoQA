# functest-hybrid 構築計画・進捗（再開用）

> Next フロント + Hono API on Workers のハイブリッド。**案Y = Next proxy（同一オリジン・httpOnly cookie）**。
> 既存2repo（`functest-freelance`=フロント、`functest-hono`=API）を土台にコピー再構成する。
> **中断時はこのチェックリストの続きから再開すること。**

## アーキテクチャ（確定）

```
functest-hybrid/   (npm workspaces)
├─ apps/
│  ├─ api/   ← functest-hono をコピー。Hono API(Workers)。AppType を export
│  └─ web/   ← functest-freelance をコピーし、バックエンドを撤去してフロント専用に
└─ packages/
   └─ shared/  ← Zod スキーマ（API検証 + RHF で共有）。AppType も re-export
```

- **接続=案Y**：web の `app/api/[...path]/route.ts` が BFF プロキシ。httpOnly cookie `session`(JWT) を読み、`Authorization: Bearer` を付けて `API_ORIGIN`(=Hono) へ転送。
- **ログインだけ特別扱い**：`auth/login` は Hono の `{token}` を受けて **httpOnly cookie に格納**し、トークンはクライアントへ返さない（`{ok:true}` を返す）。ログアウトは cookie 削除。
- **型**：Hono `export type AppType = typeof app` → web が `hc<AppType>` で型付きクライアント。baseUrl=`/api`（同一オリジン→proxy）。
- DB は **api 側のみ**（Drizzle + docker Postgres :5435 / 本番 Neon）。web は DB を持たない。
- env: web に `API_ORIGIN`（dev=`http://localhost:8787`）。

## web から撤去するもの（functest-freelance 由来）

- `src/server/*`（tRPC, db, authz, trpc routers）→ **削除**（認可は api 側へ）
- `prisma/`、`@prisma/client`/`prisma` 依存 → 削除
- `src/auth.ts`、`@/app/api/auth/[...nextauth]`、`next-auth` → 削除（認証は Hono JWT）
- `src/lib/trpc/*`、`@trpc/*` 依存 → 削除（→ `hc` クライアントへ）
- `src/inngest/*`、`@/app/api/inngest`、`@/app/api/trpc`、`@/app/api/health` → 削除
- `src/app/api/health` は不要（health は api 側）

## web で残す/書き換えるもの

- UI: `src/app/login/page.tsx`、`src/app/todos/*`、`src/components/ui/*`、Tailwind、shadcn → 残す
- フォーム: react-hook-form + Zod（Zod は `packages/shared` から import に変更）
- データ取得: TanStack Query は残すが、tRPC ではなく `hc` クライアント経由に書換
- `providers.tsx`: SessionProvider(next-auth) を撤去、TanStack Query Provider だけに

## 新規作成するもの

- ルート `package.json`（workspaces: `apps/*`, `packages/*`）
- `packages/shared/`：`schemas.ts`(Zod login/todo), `index.ts`, package.json, tsconfig
- `apps/api`：`src/index.ts` に `export type AppType = typeof app` 追記（CORS は proxy なので不要）
- `apps/web/src/app/api/[...path]/route.ts`：BFF プロキシ（cookie→Bearer / login特例 / logout）
- `apps/web/src/lib/api.ts`：`hc<AppType>` クライアント（baseUrl `/api`）
- `apps/web` の `next.config.ts`：（proxyはroute handlerで行うため rewrites 不要。API_ORIGIN は env）

## チェックリスト（全完了 2026-06-15）

- [x] 1. ルート `package.json`（workspaces）作成
- [x] 2. `apps/api` ← functest-hono、name `@hybrid/api`、`export type AppType` 追加
- [x] 3. `apps/web` ← functest-freelance、name `@hybrid/web`
- [x] 4. `packages/shared`（Zod スキーマ集約）作成
- [x] 5. api: schemas を shared 参照に、ルートを **hc 型推論のためチェーン化**
- [x] 6. web: バックエンド撤去（prisma/trpc/next-auth/inngest/db/server）。依存削除
- [x] 7. web: `hc` クライアント `src/lib/api.ts`
- [x] 8. web: BFF プロキシ `app/api/[...path]/route.ts` ＋ `app/api/logout/route.ts`
- [x] 9. web: login/todos を `hc`＋cookie ログインに書換、providers から next-auth 撤去
- [x] 10. ルート `npm install`、api は既存 fh-db(:5435) を流用
- [x] 11. 検証（下記）
- [x] 12. PROGRESS/memo 更新

## 検証結果（実機）

| 検証 | 結果 |
|---|---|
| api typecheck / web typecheck | ✓ 両方 pass |
| api Vitest（認可境界・RBAC） | ✓ 10/10 |
| web `next build` | ✓ |
| web→proxy `/api/auth/login` | ✓ **httpOnly cookie セット・token はJSONに出ない（{ok:true}）** |
| web→proxy `/api/todos`（cookie→Bearer） | ✓ 自分のTodo取得 |
| user→`/api/admin/stats` | ✓ **403** |
| admin→`/api/admin/stats` | ✓ `{users:2,todos:3,done:1}` |
| logout | ✓ cookie 削除（Max-Age=0） |

### ハマり所（記録）
- **hc が `unknown`**：Hono RPC はルートを**メソッドチェーンで定義**しないと型が蓄積しない → app.ts と routes/* を全てチェーン化して解決。
- **web が api 源の `@/` を解決できない**（モノレポ定番）→ web tsconfig の `@/*` に `../api/src/*` をフォールバック追加。
- **WebCrypto の BufferSource 型が lib 差で衝突**（api=ES2022 / web=DOM）→ DOM 型名を使わず ArrayBuffer 裏付け Uint8Array にコピーして両対応。

## 残タスク（任意）
- Cloudflare Workers への実デプロイ（api: `wrangler secret put` → `cf:deploy` / Neon）。web: Vercel/Pages。本番は web の `API_ORIGIN` を Worker URL に。
- web の認証ガードを middleware 化（現状はクライアントで 401→/login）。
- 型境界の堅牢化（将来 api を d.ts ビルドして web は成果物を参照する形へ）。
- CI（GitHub Actions、Postgres service 込み）。

## 検証の要点（完了基準）

- web(:3000) → `/api/auth/login` で httpOnly cookie がセットされる（JSにtoken露出しない）
- web から `/api/todos` が cookie 経由で認証通過し自分のTodoのみ返る
- 一般ユーザーで `/api/admin/stats` → 403、admin → 集計
- api 側 Vitest 10件が引き続き緑
- web の `next build` が通る

## ポート/環境メモ

- api(Hono dev/Node): **:8787**、DB docker Postgres **:5435**（test=functest_hono_test）
- web(Next dev): :3000（このマシンは 3000/3100 が別アプリ占有のことあり→必要なら PORT 変更）
- cookie 名 `session`、httpOnly/SameSite=Lax/path=/、prod は secure

## 関連

- 設計の経緯: `functest-hono/memo.md`、メモリ `functest-variants.md` / `engineering-priority-authz-over-authn.md`
