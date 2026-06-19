# DeepSeek handoff: mise.toml + Dockerfile（k8s移行 step1-2）

作成 2026-06-18 / Claude → Kilo(DeepSeek)。
**タスク**: `docs/k8s-migration-plan.md`（2026-06-18更新版）のロードマップ **step1(mise) と step2(Dockerfile)** を実装する。
k3d/k8s/ArgoCD と独立に今すぐ着手できる範囲。**実装はまだゼロ**なので新規作成。

> 前提を必ず読む: `docs/k8s-migration-plan.md` の §1,§2,§8。特に §8-6（routing は post-hoc cascade に転換）と
> edge=Gemma4 は GPU必須/in-cluster は埋め込みのみ、という制約。

## 成果物

### 1) `mise.toml`（リポジトリ直下・新規）
- `[tools] node = "22"`
- `[env] _.file = ".env"`（既存 .env を読む）
- `[tasks]` に既存 npm scripts を薄くラップ: `dev-api`(=`npm run dev:api`)、`dev-web`(=`PORT=3456 npm run dev:web`)、
  `typecheck`(=`npm run typecheck`)、`test-api`(=`npm run test:api`)、`db-up`/`db-push`/`db-seed`、
  `eval-routing`(=`OLLAMA_EMBED_MODEL=bge-m3 npm run eval:routing -w @hybrid/api`)。
- 既存 npm scripts は壊さない（入口を増やすだけ）。

### 2) `apps/api/Dockerfile`（新規・マルチステージ）
- base: `node:22-slim`。
- deps ステージ: ルートの `package.json` + `package-lock.json` + 各 workspace の package.json をコピー → `npm ci`（モノレポなのでルートから）。
- build ステージ: `@hybrid/shared` と `@hybrid/api` をビルド。**本番起動は Node エントリ `src/dev.ts`**（Workers の index.ts は使わない）。
  - 現状 api に本番 `build`/`start` script が無い → **追加が必要**:
    - `apps/api/package.json` に `"build": "tsc -p tsconfig.json"`（or esbuild バンドル）、`"start": "node dist/dev.js"` を足す。
    - tsx 常駐運用を避け、ビルド済み JS を `node` で起動（コンテナの定石）。tsx 直実行でも可だが prod は build 推奨。
- runtime ステージ: 非 root ユーザ、`dist` + 必要 node_modules のみ。`EXPOSE 8787`。
- 必要 env（ConfigMap/Secret で後注入。Dockerfile にはハードコードしない）:
  `DATABASE_URL`(TCP), `JWT_SECRET`, `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`,
  `AI_ROUTER=classifier`, `OLLAMA_URL`(in-cluster ollama Service), `OLLAMA_EMBED_MODEL=bge-m3`,
  `CF_ACCOUNT_ID`/`CF_API_TOKEN`(edge=Workers AI を呼ぶ場合)。
- **ヘルスチェック**: readiness 用の軽量エンドポイントが要る。api に `GET /health`（DB ping + 200）が無ければ
  最小実装を追加（`createApp` のチェーンに `.get("/health", ...)` ＝ RPC 型を壊さない形で）。
  起動時ウォームアップ（分類器 build の await）は §2 の課題だが本 handoff では **/health の追加まで**でよい（warmup は k3d 段で）。

### 3) `apps/web/Dockerfile`（新規・マルチステージ）
- **前提作業**: `apps/web/next.config.*` に `output: "standalone"` を追加（無いと standalone 生成されない）。
- build → `.next/standalone` + `.next/static` + `public` を runtime ステージへ。`node server.js` 起動。`EXPOSE 3000`。
- env: `API_ORIGIN`（api Service URL。BFFプロキシ `app/api/[...path]/route.ts` が参照）。

### 4) `.dockerignore`（ルート / 各 app）
- `node_modules`, `.next`, `dist`, `.env*`, `**/*.log`, `kilo/`, `docs/`, `apps/api/eval/data/*.jsonl`(大) を除外。

## 検証（Kilo が実施）
```bash
# mise
mise --version && mise tasks            # tasks 一覧に dev-api 等が出る
mise run typecheck                       # 既存 typecheck が mise 経由で通る

# api イメージ
docker build -f apps/api/Dockerfile -t hybrid-api:dev .
docker run --rm -e DATABASE_URL=... -e JWT_SECRET=dev -p 8787:8787 hybrid-api:dev &
curl -fsS localhost:8787/health          # 200 が返る

# web イメージ
docker build -f apps/web/Dockerfile -t hybrid-web:dev .
docker run --rm -e API_ORIGIN=http://host.docker.internal:8787 -p 3000:3000 hybrid-web:dev &
curl -fsS localhost:3000                 # トップが返る
```

## やらないこと（スコープ外＝次段 step3 以降）
- k3d クラスタ作成、Kustomize manifest、Secret(SealedSecrets)、ArgoCD、GPU ノード、ollama Deployment。
- これらは step1-2（本書）の Dockerfile が通ってから別 handoff。

## 注意
- **型推論の制約**: `/health` は `createApp` の `.route()`/`.get()` チェーンに足す（バラすと hc 型が unknown 化。CLAUDE.md 参照）。
- web の tsconfig が api 源の `@/` を解決する既存フォールバックを壊さない。
- 本番 build を足したら `npm run typecheck` と既存 `test:api` が通ることを確認。
- 完了後 Claude が Dockerfile/health/standalone をレビューし、計画書 step3(k3d) の handoff に進む。

関連: `docs/k8s-migration-plan.md`（2026-06-18版） / [[selective-routing-pivot]] / [[local-cpu-edge-infeasible]]
