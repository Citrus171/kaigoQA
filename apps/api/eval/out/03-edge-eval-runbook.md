# 03 edge 比較用 実行手順書（runbook）

**目的**: 参照 gold 採点を edge 候補モデル（gemma3:4b / Granite 等）の比較に流用するための、
コマンドテンプレート・環境変数一覧・入出力命名規則の手順書。**実際の judge API 呼び出しは行わない**（人間が戻ってから実行）。

---

## 1. ハーネス概要

| スクリプト | 目的 | 実行コマンド |
|---|---|---|
| `eval-e2e.ts` | edge生成(gemma3:4b) + cloud生成(deepseek) + 自己採点(同一deepseek)を一気通貫 | `npm run eval:e2e -w @hybrid/api` |
| `rejudge.ts` 単発モード | 保存済み E2E JSONL を入力に、**独立 judge**（別系統）で再採点 | `npm run eval:rejudge -w @hybrid/api -- <input>` |
| `rejudge.ts` flipモード | 同一回答を jud

ge に K 回かけ判定の揺れ（flip率）を定量化 | `npm run eval:rejudge -w @hybrid/api -- <input> --repeat K` |

## 2. 環境変数一覧

### eval:e2e（edge生成・E2E計測）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama サーバーの URL |
| `OLLAMA_GEN_MODEL` | `llama3.2:1b` | **edge生成に使うローカルモデル。edge候補を変えるときはこれだけ差し替える** |
| `OPENCODE_API_KEY` | —（必須） | OpenCode Go の API キー（cloud生成 + judge 両方） |
| `OPENCODE_MODEL` | `deepseek-v4-pro` | cloud生成・judge に使うモデル |
| `OPENCODE_TIMEOUT_MS` | `60000` | cloud API タイムアウト（ms） |
| `E2E_LIMIT` | `0`（全件） | 疎通確認用。正数指定で先頭N件のみ実行 |
| `E2E_ONLY_CLOUD` | `0` | `1` で edge生成スキップ（always-cloudのlatency/品質のみ・GPU不要） |

### eval:rejudge（独立 judge 再採点）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `OPENROUTER_API_KEY` | —（必須） | OpenRouter または OpenAI 直の API キー |
| `JUDGE_MODEL` | `openai/gpt-4o` | **独立 judge のモデル。OpenAI 直なら `gpt-4o`、Claude なら `anthropic/claude-opus-4`** |
| `JUDGE_BASE_URL` | `https://openrouter.ai/api/v1/chat/completions` | **OpenAI 直なら `https://api.openai.com/v1/chat/completions`、Claude API 直ならその URL** |
| `JUDGE_TIMEOUT_MS` | `60000` | judge API タイムアウト（ms） |
| `JUDGE_TEMPERATURE` | `0`（単発）/ `0.7`（flip自動） | **flipモードでは非0必須。K≥2 で未設定なら自動 0.7** |
| `REJUDGE_REPEAT` | `1` | `--repeat K` の環境変数版 |

## 3. コマンドテンプレート（穴埋め形式）

### Step 1: edge 候補モデルで E2E 計測

```bash
# === edgeモデルを差し替えて E2E を回す ===
# <EDGE_MODEL> に gemma3:4b / granite3.2:2b 等を指定

OLLAMA_GEN_MODEL=<EDGE_MODEL> \
  OPENCODE_API_KEY=<YOUR_KEY> \
  npm run eval:e2e -w @hybrid/api

# 出力: apps/api/eval/data/e2e-ollama-<slug>.jsonl
# <slug> = OLLAMA_GEN_MODEL の英数字化。例: gemma3-4b, granite3-2-2b
```

### Step 2: 独立 judge（GPT-4o 推奨）で再採点（単発モード）

```bash
# === 保存した E2E 出力を独立 judge で再採点 ===
# 既定 judge = OpenRouter 経由 GPT-4o（生成系 deepseek と別系統＝自己採点バイアス除去）

OPENROUTER_API_KEY=<YOUR_KEY> \
  npm run eval:rejudge -w @hybrid/api \
  -- apps/api/eval/data/e2e-ollama-<EDGE_SLUG>.jsonl

# 出力: apps/api/eval/data/rejudge-judge_<judge_モデル>-e2e-ollama-<slug>.jsonl
# 標準出力にポリシー別 good率（独立judge vs 旧自己採点）と judge間一致度が表示される
```

### Step 3（オプション）: flip率モードで judge ノイズ床を比較

```bash
# === 独立 judge のノイズ床（判定の揺れ）を定量化 ===
# 参照採点あり/なし両方で K=5 回判定し flip率を比較する
# 対象は answerReview=approved の参照あり項目のみ（自動フィルタ）

OPENROUTER_API_KEY=<YOUR_KEY> \
  JUDGE_TEMPERATURE=0.7 \
  npm run eval:rejudge -w @hybrid/api \
  -- apps/api/eval/data/e2e-ollama-<EDGE_SLUG>.jsonl --repeat 5

# 出力: apps/api/eval/data/flip-judge_<judge_モデル>-k5-e2e-ollama-<slug>.jsonl
# 標準出力に flip率（off/on）・多数決good率・flip項目一覧が表示される
```

### Step 4: edgeモデル間の比較

```bash
# === 2つの E2E JSONL を同じ judge で再採点し、ポリシー別 good率を横並び比較 ===
# 例: gemma3:4b vs granite3.2:2b

# gemma3 の再採点
OPENROUTER_API_KEY=<YOUR_KEY> \
  npm run eval:rejudge -w @hybrid/api \
  -- apps/api/eval/data/e2e-ollama-gemma3-4b.jsonl

# granite の再採点
OPENROUTER_API_KEY=<YOUR_KEY> \
  npm run eval:rejudge -w @hybrid/api \
  -- apps/api/eval/data/e2e-ollama-granite3-2-2b.jsonl

# 両方の標準出力の「ポリシー別 good率」表を横に並べ、
# always-edge の good率差で edge 候補の品質を比較する。
```

## 4. 入出力パス命名規則

### eval:e2e 出力

```
apps/api/eval/data/e2e-<edgeSlug>.jsonl
apps/api/eval/data/e2e-<cloudSlug>-cloudonly.jsonl  # E2E_ONLY_CLOUD=1 時
```

`<edgeSlug>` = `OLLAMA_GEN_MODEL` の非英数字を `-` に置換。例:
- `gemma3:4b` → `e2e-ollama-gemma3-4b.jsonl`
- `granite3.2:2b` → `e2e-ollama-granite3-2-2b.jsonl`

### eval:rejudge 出力

```
# 単発モード
apps/api/eval/data/rejudge-<judgeSlug>-<inputBasename>

# flipモード (K≥2)
apps/api/eval/data/flip-<judgeSlug>-k<K>-<inputBasename>
```

`<judgeSlug>` = `JUDGE_MODEL` の非英数字を `-` に置換。例:
- `openai/gpt-4o` → `judge_openai-gpt-4o`
- `anthropic/claude-opus-4` → `judge_anthropic-claude-opus-4`

### 入力ファイル（既存）

| ファイル | 内容 |
|---|---|
| `e2e-ollama-gemma3-4b.jsonl` | gemma3:4b edge + deepseek cloud の GPU full E2E（34件） |
| `e2e-opencode-go-deepseek-v4-flash-cloudonly.jsonl` | cloud生成のみ（E2E_ONLY_CLOUD=1、edge未測定） |
| `routing-gold.jsonl` | gold データ 34件（参照要点・answerReview=approved が11件） |

## 5. 注意点

### 照採点の利用

`rejudge.ts` は `referencePointsOf()`（`data/load.ts`）を介して、`answerReview === "approved"` の項目にのみ参照採点を適用する。未承認の項目は参照なし採点にフォールバックする。`routing-gold.jsonl` の承認状況は `answerReview` フィールドを確認すること（`reviewStatus` は34件すべて `pending`）。

### 自己採点バイアス

`eval:e2e` の cloud 採点は生成と同一 deepseek＝自己採点。比較には `rejudge.ts` の独立 judge good率を使うこと。

### judge 温度

- 単発モード: `JUDGE_TEMPERATURE=0`（決定論的・再現性重視）
- flipモード: `JUDGE_TEMPERATURE=0.7`（K≥2 で自動設定、明示指定も可）。温度0ではflipが起きないため flipモードでは非0必須。

### API キー管理

- `OPENCODE_API_KEY`: OpenCode Go（`https://opencode.ai`）の API キー
- `OPENROUTER_API_KEY`: OpenRouter（`https://openrouter.ai`）または OpenAI 直の API キー。OpenAI 直を使う場合は `JUDGE_BASE_URL=https://api.openai.com/v1/chat/completions` も併せて設定

### GPU 要件

- `eval:e2e` は edge生成に Ollama を使うため、**gemma3:4b 等の 4B+ モデルでは GPU が実用的に必要**。CPU では p50=33s 程度と実用的でない。
- `eval:rejudge` は API 越しの judge のみで GPU 不要（OpenRouter/OpenAI の外部 API を使用）。
