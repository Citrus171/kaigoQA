# 15 Dataset A GPU実行 runbook（Ph2p 先行edge生成）

2026-06-18 起票。**人手承認と並行**して走らせる GPU 先行生成の手順。
edge生成(gemma3:4b)は**クエリ本文だけに依存**し expected/閾値/承認ラベルを使わないため、承認完了を待たず先に重い生成を確保してクリティカルパスから外す（GPU優先方針）。

> 位置づけ: prod edge は Workers AI 想定。GPU-Ollama-gemma3:4b は代理値（`docs/e2e-gpu-runbook.md` の「prod再測」と同じ前提）。

## 前提（pod側）
1. **コードと入力は git pull で揃う** — `feat/ai-routing-poc-impl` の `dac30e5` 以降を pull。
   `EVAL_GOLD_FILE`/`loadGoldFromEnv` 対応（`35fe7b7`）に加え、`out/14-dataset-a-queries.jsonl` も追跡対象化済（`dac30e5`）なので**scp不要**。
2. **入力配置** — `cp apps/api/eval/out/14-dataset-a-queries.jsonl apps/api/eval/data/routing-gold-a.jsonl`
   （承認後の確定版を commit すれば以降は `data/routing-gold-a.jsonl` も git で travel する。）
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
**推奨: `E2E_ONLY_EDGE=1`（cloud生成とjudgeをスキップ＝外部API非依存）。**
2026-06-18 の実走で cloud API（OpenRouter）が 12→60s/件と劣化し GPU をほぼアイドルで抱えた教訓。
GPUセッションは edge答案(gemma3:4b)＋振り分け(bge-m3)だけ回し、cloud答案と採点は後段で別途。
```bash
cd apps/api
EVAL_GOLD_FILE=routing-gold-a.jsonl E2E_ONLY_EDGE=1 \
OLLAMA_URL=http://localhost:11434 OLLAMA_GEN_MODEL=gemma3:4b OLLAMA_EMBED_MODEL=bge-m3 \
  npm run eval:e2e -w @hybrid/api
# 出力: apps/api/eval/data/e2e-ollama-gemma3-4b-edgeonly.jsonl（edge答案/latency/振り分け）
# 10件ごとに逐次フラッシュ＝中断しても途中まで回収可能。
```
> 疎通だけ先に見るなら `E2E_LIMIT=3` を足す。
> cloud側も同セッションで取るなら `E2E_ONLY_EDGE` を外す（ただしAPI律速で長時間化に注意）。
> always-cloud だけ別途取るなら `E2E_ONLY_CLOUD=1`（GPU不要・API健全時に手元で）。

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
