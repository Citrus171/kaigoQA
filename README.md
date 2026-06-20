# functest-hybrid — Next フロント + Hono API on Workers

既存2repo（`functest-freelance`=フロント / `functest-hono`=API）を**コピー再構成**したハイブリッド雛形。
接続は **案Y：Next の BFF プロキシ（同一オリジン・httpOnly cookie）**。

> 詳細な設計判断・進捗・ハマり所は **`PROGRESS.md`**（一次情報）。

---

## AIルーティングPoC（介護保険QA）— Evaluation-driven RAG engineering

介護保険QAを題材に、**RAGの品質を評価し、故障を切り分け、評価結果からアーキテクチャを変更する**までを実装した PoC。
「RAGを作る」ではなく **評価基盤 → 故障分析 → ルート設計 → ガードレール → 構造化ログ** の流れが主眼。

### Architecture

```
User Query  (POST /ai/qa ― 単一エンドポイント)
    │
    ▼
RAG 検索 → top-1 score でドメイン判定 (θ=0.5)
    ├─ score < θ : general（介護保険ドメイン外）
    │                └─ edge(Gemma 4)↔cloud ルーティング（RAGなし）
    └─ score ≥ θ : Capability Router (LLM分類器, 分類精度 98.5%)
                     ├─ knowledge_qa → RAG (top-3 retrieval + 生成)
                     └─ escalation   → guarded response
                                       （数値の捏造を抑止し「手順＋制度定数＋ケアマネ誘導」へ）
```

設計判断の核心: 評価データ（gold）が「計算系質問は決定論的単一解を持たない」ことを示したため、
当初想定の *Tool route（決定論計算）* を**廃止**し、escalation guardrail に置き換えた（データ駆動の設計変更）。

### Evaluation Pipeline

```
Gold Dataset (135件, 5カテゴリ, referencePoints付き)
    ▼
Oracle RAG ……… retrieval不足 / generation不足 を分離
    ▼
LLM Judge (relaxed=正規KPI / strict=副軸)
    ▼
Failure Analysis (missing / omitted / misinterpreted / factual / overreach)
    ▼
Router Design (評価結果→route分岐＋route適応生成)
```

### Results (relaxed KPI)

```
88.1%  →  92.6%  →  94.1%
top-1     top-3      Capability Router
          (retrieval) (omitted/factual を route で解消, 回帰0)
```

- 詳細レポート: **[`apps/api/eval/PHASE1-EVAL-REPORT.md`](apps/api/eval/PHASE1-EVAL-REPORT.md)**（評価基盤・故障分離）
- ルーター評価: **[`apps/api/eval/out/42-router.md`](apps/api/eval/out/42-router.md)**（分類精度・before/after・設計反復）
- 再現コード/ログ: `apps/api/eval/out34-*.py`〜`out42-router.py` / `apps/api/eval/data/rag-router-log.jsonl`

---

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
