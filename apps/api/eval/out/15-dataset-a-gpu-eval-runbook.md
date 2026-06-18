# 15 Dataset A GPU実行 runbook（Ph2p 先行edge生成）

2026-06-18 起票。**人手承認と並行**して走らせる GPU 先行生成の手順。
edge生成(gemma3:4b)は**クエリ本文だけに依存**し expected/閾値/承認ラベルを使わないため、承認完了を待たず先に重い生成を確保してクリティカルパスから外す（GPU優先方針）。

> 位置づけ: prod edge は Workers AI 想定。GPU-Ollama-gemma3:4b は代理値（`docs/e2e-gpu-runbook.md` の「prod再測」と同じ前提）。

## 前提（pod側）
1. **コードは最新commit** — `feat/ai-routing-poc-impl` の `35fe7b7` 以降（`EVAL_GOLD_FILE`/`loadGoldFromEnv` 対応が無いと A を指せない）。pod で `git pull` 必須。
2. **入力データ out/14 は手動転送** — `apps/api/eval/out/` は **gitignore対象＝git pull で来ない**。`out/14-dataset-a-queries.jsonl` を手元から pod へ **scp** する。
   ```bash
   scp apps/api/eval/out/14-dataset-a-queries.jsonl <pod>:.../apps/api/eval/data/routing-gold-a.jsonl
   ```
   （`data/routing-gold-a.jsonl` は gitignore 対象外なので、承認後に commit すれば以降は git で travel する。pre承認の今は scp。）
3. **Ollama** に `gemma3:4b`（edge生成）と `bge-m3`（段1分類器の埋め込み）pull 済み。
4. **`.env`** に cloud生成＋judge 用キー（`OPENROUTER_API_KEY` 等。eval-e2e は loadEnv で .env を読む）。
5. **tmux 必須**（切断対策）。Community Cloud はディスクフル注意 → **Secure Cloud 推奨**。

## 手順

### 1. Ollama 起動 + モデル
```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve &
ollama pull gemma3:4b
ollama pull bge-m3
curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"'   # 両モデル確認
```

### 2. 先行E2E生成（全120件・承認前でOK）
```bash
cd apps/api
EVAL_GOLD_FILE=routing-gold-a.jsonl \
OLLAMA_URL=http://localhost:11434 OLLAMA_GEN_MODEL=gemma3:4b OLLAMA_EMBED_MODEL=bge-m3 \
  npm run eval:e2e -w @hybrid/api
# ヘッダに `gold source=routing-gold-a.jsonl` が出れば対象A。
# 出力: apps/api/eval/data/e2e-ollama-gemma3-4b*.jsonl（edge+cloud答案/latency入り）
```
> 疎通だけ先に見るなら `E2E_LIMIT=3` を足す。

### 3. 回収（md5照合）
```bash
md5sum apps/api/eval/data/e2e-ollama-gemma3-4b*.jsonl   # pod側
# 手元へ転送後、同じ md5 を照合（破損検知）
```

## この段階の割り切り（重要）
- **judge は参照なし**（承認前で `answerReview` 未approved → referencePoints が流れない）。**この judge 結果は捨てる**。
- 価値は**重い edge生成（＋cloud生成）の確保**。参照付き採点は承認後に `rejudge` でやり直す。
- 承認で**クエリ本文が編集された数件だけ**後で再生成（近接リーク0なので編集はほぼ無い見込み）。expected/★ の修正は再生成不要。

## 承認完了後（Ph4＝別マシンでも可・GPU不要）
承認済み `routing-gold-a.jsonl`（approved 反映）を data/ に置いた上で、生成済みJSONLを独立judgeで再採点:
```bash
# 参照採点（approved の referencePoints が流れる）。判定は OpenRouter(GPT-4o)
EVAL_GOLD_FILE=routing-gold-a.jsonl \
  npx tsx --env-file=.env eval/rejudge.ts data/e2e-ollama-gemma3-4b-gpu.jsonl
# 出力: data/rejudge-judge-openai-gpt-4o-*.jsonl
```
その後 split→閾値→loss は手元で:
```bash
npm run split:gold-a -w @hybrid/api                       # A-dev/A-holdout 生成
EVAL_GOLD_FILE=routing-gold-a-dev.jsonl npm run eval:routing -w @hybrid/api   # 動作点決定
```

## 教訓（踏襲）
- 生成と judge は分離（生成JSONLを残し、judge は後段で差し替え可能に）。
- tmux 常用 / 転送は md5 照合 / Secure Cloud（ディスク）/ harness timeout に注意。

## 関連
- 評価設計の確定 = `share/2026-06-18-03-eval-design-decision.md`（train=prototype / A-dev=閾値 / A-holdout=凍結）
- 承認チェックリスト/トリアージ = `share/2026-06-18-01,02-...`
- 既存GPU手順 = `docs/e2e-gpu-runbook.md`
