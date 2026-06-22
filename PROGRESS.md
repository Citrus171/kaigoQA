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

## AIハイブリッドルーティング PoC（2026-06-16 実装・完了）

> 設計: `docs/poc-ai-routing.md`。ブランチ `feat/ai-routing-poc-impl`。dev=ローカルOllama / escalation=OpenCode Go。

- 追加物:
  - `packages/shared/src/schemas.ts`: `aiAskSchema` / `aiAnswerSchema`（応答型 = 単一の真実）。
  - `apps/api/src/lib/inference.ts`: `InferProvider` 抽象 + `OllamaProvider`(dev edge) + `OpenCodeProvider`(escalation, deepseek-v4-flash)。`InferenceError` で上流障害を区別。
  - `apps/api/src/lib/classify.ts`: `classifyComplexity()`（段1ルール。長文>200字 or 法令/診断/計算等キーワードで即 cloud）。
  - `apps/api/src/routes/ai.ts`: `POST /ai/ask`。JWT必須・チェーン化。段1→段2(SLM自信≥0.6で edge / 未満で cloud)。推論障害は 502。
  - `apps/api/src/app.ts`: `.route("/ai", aiRoutes)` 追加。
- 検証結果（全て緑）:
  - 「こんにちは」→ `tier:edge`（Ollama）/ 「介護保険法第8条…」→ `tier:cloud`（段1判定→OpenCode Go 実応答）/ token無し→401 / 空prompt→400。
  - typecheck(api+web) 緑、既存 Vitest 10件 緑。
- ハマり所/注記:
  - **llama3.2:1b の自己申告 confidence はノイズ大**（「こんにちは」に confidence:1 で answer:"正解" 等）。PoC目的=ルーティングの型が動く確認。本番は logprobs/複雑度分類器へ差し替え前提。
  - `OPENCODE_API_KEY` は `apps/api/.env`（コード直書き禁止）。
- 後続(任意): `WorkersAiProvider`(prod edge=Workers AI binding, localhost不可対策) / `wrangler.toml [ai]` / `OPENCODE_API_KEY` を wrangler secret 化 / 越境型 hc<AppType> での web 連携。

### 本番化の改善順序（ADR 0001 採択 2026-06-16）

> `docs/adr/0001-edge-routing-improvement-order.md`。順序: 評価セット → **複雑度分類器(A-2)** → 閾値調整 → logprob confidence(A-1) → RAG → モデル増強。
> 決め手: logprobも自己申告confidenceも「1Bモデル自身の認識」に依存し失敗モードを共有。独立した複雑度分類器の方がROI高い。

- **Step1 完了（評価基盤）**: `apps/api/eval/routing-gold.ts`(介護gold 34件・cloud寄り層化・ラベル暫定/要実務者レビュー) + `eval/eval-routing.ts`(計測)。`npm run eval:routing -w @hybrid/api`。
  - 注目クラス=cloud、FN(本来cloud→edge)重視、非対称コスト FN:FP=10:1、Recall目標90%。
  - **ベースライン(段1 rule-base)結果 = Red**: Recall **15%**(cloud 20件中TP3/FN17)、Precision100%、加重コスト170。→ rule-baseはキーワード非含有の難問(回数判断/加算算定/個別ケース)を取りこぼす定量証拠。Step2(Embedding+LR分類器)で改善対象。
- **Step2-3 完了（分類器＋閾値調整）**:
  - LR→**セントロイド・コサイン**へ逸脱（llama3.2:1bのみ＝2048次元×少数ラベルでLRは過学習）。`src/lib/embed.ts`(EmbedProvider二刀流), `src/lib/classify-embed.ts`(buildCentroidClassifier), `eval/routing-train.ts`(学習24件・リーク防止)。
  - 閾値 t* は train で加重コスト最小化(FN:FP=10:1)→held-out適用。**Recall 15%→40%→90%、FN 17→2、コスト 170→24**。既存Vitest10件・typecheck緑。
  - 残: FN2/Precision81.8%（llama3.2:1b埋め込み限界）。**ライブ`ai.ts`未wiring**（embed1回/起動時セントロイド構築のlatency判断＝Step2b）。
- **Step2b 完了（ライブ`ai.ts`へwiring）**:
  - `src/lib/routing-prototypes.ts`(プロトタイプをsrcへ移動=モデルの一部), `src/lib/routing.ts`(起動時セントロイド構築シングルトン+閾値チューニング), `classify-embed.ts`に`tuneThreshold`正準化（evalと共有）。
  - `ai.ts`: 段1を`preRoute()`化。**フラグ`AI_ROUTER=classifier`で有効**（既定rule-base＝既存挙動/テスト/prod無影響）。埋め込み失敗時はrule-baseへグレースフルフォールバック。埋め込みprovider使い回し。
  - liveスモーク(`AI_ROUTER=classifier`): 挨拶→cloud(FP) / 要介護2回数→cloud / 営業時間→edge / 加算算定→cloud。**evalと完全整合**（wiring忠実）。typecheck・既存Vitest10件緑。
- **⚠️ 正直な発見（動作点の問題）**: t*=-0.134 の (C) は **Recall94.1%だがPrecision61.5%（FP=10/17）**。挨拶3件含むedgeの6割をcloudへ過剰escalation。「Recall94.1% ✅」はprecision崩壊を隠していた。原因=(1)llama3.2:1b埋め込みの分離力不足 +(2)コスト比10:1がrecall優先で閾値を下げすぎ。OpenCode Goは定額で金銭損なしだがUX不合理（[[opencode-go-flat-rate-cost]]）。
- 次候補: (a) **コスト比/動作点の再検討**（10:1見直し or 第2防衛線=段2confidenceで救済）/ (b) Step4 Shadow Mode（この過剰escalationを本番前に観測）/ (c) prod埋め込み(bge)で分離力改善＋再チューニング(parity) / (d) goldラベルの実務者レビュー。

## AI入口の統合と edge+RAG tier（2026-06-20）

> ブランチ `feat/ai-routing-poc-impl`。上記 2026-06-16 PoC から、評価（フェーズ1=RAG品質 / フェーズ2=Capability Router）を経て、エンドポイント統合と edge tier 追加まで実装。

- **エンドポイント統合**: `/ai/ask` を廃止し **`POST /ai/qa` に一本化**。段1=RAG top-1 score でドメイン判定(θ=0.5)、ドメイン外=`generalAnswer`(edge↔cloud, RAGなし)、ドメイン内=`domainAnswer`(Capability Router + RAG)。
- **Capability Router + RAG**: `knowledge_qa` / `escalate` に分類（精度 98.5%）し route 別生成。`escalate` は個別ケースの数値捏造を抑止する guardrail 生成（手順＋制度定数＋ケアマネ誘導）。
- **edge+RAG tier（cascade）**:
  - `WorkersAiProvider` を thinking off 化（`chat_template_kwargs:{enable_thinking:false}` / `max_tokens` 512）+ `infer(prompt, system?)` で RAG system を受け取り対応。
  - `domainAnswer` の `knowledge_qa` を **edge(Gemma 4)+RAG 一次生成 → 退化(空・極短)/危険断定なら cloud fallback**。`escalate` は cloud 維持。
  - 評価: edge 90.2% ＞ cloud flash 85.4%（同基盤・gold-a 41件・`eval/out/44`）/ 実装前シミュレーション fallback 0%（`eval/out/45`）/ 本番フロー41件実測も fallback 0%・空答 0%（`eval/out/46`）。
  - 経路忠実性: 本番フロー答案を out/44 同一 judge(gpt-4o・全ref統一)で採点し **90.2% = eval経路 90.2%（差 0pt・`eval/out/47`）**＝本番 `/ai/qa` 配線が評価スクリプトと同等品質の答案を生成。relaxed 90.2%(実用KPI)/strict 58.5%。
- **テスト**: cascade 3分岐（edge確定 / 退化fallback / risky fallback）の関数単体（`test/ai-qa.test.ts`）+ `app.request("/ai/qa")` の routes 配線統合（`test/ai-qa-route.test.ts`、DB/CF 不要・モック注入で配線を検証）。計 40 件緑、typecheck(api+web) 緑。
- **既知事項（最適化候補）**: `knowledge_qa` は edge 確定でも `classifyRoute` の cloud 往復が latency 律速（p50 4.4s、edge 生成自体は 〜0.9s）。→ **解消済み（下記「分類の edge 化」参照）**。

## 関連

## RAG retrieval 改善（2026-06-22）

> 詳細計画書: `docs/rag-retrieval-improvement-plan-2026-06-22.md`（gitignore対象・ローカル）。

- **A0 gold修正**: gold-A-056/071 の referencePoints を修正・corpus 再 embedding。
- **A1 hybrid retrieval**: BM25(kuromoji) + dense(pgvector) の RRF 融合。最適 w5:1 c=10。self-match @1=88.9% / @8=99.3%。`lib/bm25.ts` / `lib/retriever.ts` / `lib/rag.ts` に実装。
- **A2 reranker**: CF bge-reranker-base で計測 → **No-Go**（self-match eval と学習目的のミスマッチで全指標退行）。`lib/cf-rerank.ts` は生成後段 filter 用に残置。
- **real-query eval**: 口語短文26件で retrieval+生成を計測。第1回 good=53.8% → brevity制約緩和(網羅性優先) → 第2回 good=80.8%。`eval/eval-rag-gen.ts`。
- **RETRIEVAL_K**: 3→5 に変更（real-query @5=96.2% / @3=80.8%）。
- **B1 PDF ingestion（Track B クローズ判断撤回）**: 計画書で「現スコープ不要」としたが、ユーザーが実機で「回答がまったくだめ」を実感し覆った。厚労省「介護サービス関係Q&A集」(168頁) を1954件チャンク化し投入。x座標列復元で表構造保持・見出し前置・発出時期メタ付与。当該質問 top-1=0.872・正答生成。DB 2089 chunks。コミット `5cd103e`。
- **k3d 実機検証**: ArgoCD が push 検知で自動デプロイ。web pod の `HOSTNAME=0.0.0.0` 設定（port-forward 接続問題）は `deploy/base/web-deployment.yaml` へ永続化済み（コミット `dc5946a`）。
- **B1 後の retrieval 回帰確認（k3d 2089 chunks）**: コーパス 10倍化の影響を再 eval。旧 gold の self-match @8 99.3%→95.6%、real-query @5 96.2%→84.6% と低下するが、これは正解側が mhlw チャンクへ**正当に置換**された結果（gold 自己照合指標のバイアス）。出典 000872766.pdf 由来の自然文質問5件を本番 `/ai/qa` で検証 → 全問 top-1 に正解 mhlw チャンクがヒットし edge 生成のみで正答 → **B1 は目的（PDF 質問の品質改善）を達成**。retrieval 低下は許容トレードオフと判断。

## 分類の edge 化（latency 最適化・OpenCode 削減）（2026-06-22）

> ブランチ `feat/edge-classify-routing`。上記「既知事項」の latency 律速（`classifyRoute` の cloud 往復）への対応。

- **変更**: `domainAnswer` の `classifyRoute(question, cloud)` → `classifyRoute(question, edge)`。分類を Workers AI(Gemma) で実行し OpenCode 往復を排除。観測 `classifierVersion` も `edge.name` に修正。
- **方式選定（`eval/exp-route-*.ts`、gold 135件・escalate=5 で評価）**:
  - 純 embedding セントロイド分類 = **不可**（escalate と knowledge_qa が埋め込み空間で重複。recall100% に FP8）。意図差（一般説明 vs 個別ケース計算）は話題でなく埋め込みに乗らない。
  - キーワードヒューリスティック = **不可**（recall 2/5＝安全側の取りこぼし）。
  - **edge LLM 分類 = 採用**。原 prompt で全体 acc 94.8%・**escalate recall 5/5（取りこぼし0）**・latency p50 684ms。過剰 escalate(FP) は cloud guardrail 生成に回るだけで安全側。
- **効果**: ドメイン質問あたり OpenCode 呼び出し 概算 ~140→~12（−91%）。`knowledge_qa` は分類も生成も edge＝OpenCode ゼロ。`escalate` のみ cloud guardrail を維持。
- **検証**: test/ai-qa.test.ts・ai-qa-route.test.ts を edge 分類前提に更新、全 68 件緑・typecheck 通過。実機 E2E（k3d）で `knowledge_qa`→tier=edge / `escalate`→tier=cloud の正配線を確認。
- **残課題**: escalate gold が5件で薄い（本来はラベル拡充して再キャリブレーション）。初回クエリは BM25 索引 cold build（2089件）が latency に出る＝次の最適化候補。

- 設計の経緯: `functest-hono/memo.md`、メモリ `functest-variants.md` / `engineering-priority-authz-over-authn.md`
