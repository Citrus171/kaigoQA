# 03: edge 評価 実行手順書（runbook）

> 人間がモデル名と入力パスを埋めるだけで実行できるテンプレ。**API を叩く作業はここに含まれない。**

## 1. 実行コマンド

### 単発再採点モード（flip率測定なし、1回ずつ採点）

```bash
OPENROUTER_API_KEY=sk-or-... \
JUDGE_MODEL=<judge-model-id> \
npm run eval:rejudge -w @hybrid/api -- <input.jsonl>
```

### flip率モード（同一回答を K 回採点、off/on 比較）

```bash
OPENROUTER_API_KEY=sk-or-... \
JUDGE_MODEL=<judge-model-id> \
npm run eval:rejudge -w @hybrid/api -- <input.jsonl> --repeat <K>
```

- `--repeat K`（K≥2）で flip率モードに切り替わる。
- 温度は `JUDGE_TEMPERATURE` で指定。**未設定かつ K≥2 の場合、自動で 0.7 が設定される**（温度0ではflipが起きないため）。
- 入力省略時は `eval/data/e2e-ollama-gemma3-4b.jsonl` が既定。

## 2. 環境変数一覧

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | — | OpenRouter API キー（judge の呼び出しに使用） |
| `JUDGE_MODEL` | — | `openai/gpt-4o` | judge モデルID（OpenRouter 形式） |
| `JUDGE_TEMPERATURE` | — | K≥2 で自動 `0.7`、それ以外 provider 既定 | judge のサンプリング温度 |
| `JUDGE_BASE_URL` | — | OpenRouter endpoint | OpenAI 互換 API のベース URL（切替時） |
| `REJUDGE_REPEAT` | — | `1` | `--repeat` の env 版（CLI 引数が優先） |

## 3. 入出力パス命名規則

### 入力

- E2E 出力 JSONL（`eval:e2e` が生成）。1行1ケースで `id/query/edge{answer,verdict}/cloud{answer,verdict}/routing` を含む。
- 例: `apps/api/eval/data/e2e-ollama-gemma3-4b.jsonl`

### 出力（自動生成）

| モード | 命名規則 | 例 |
|---|---|---|
| 単発再採点 | `data/rejudge-<judgeSlug>-<入力basename>` | `rejudge-openai-gpt-4o-e2e-ollama-gemma3-4b.jsonl` |
| flip率 | `data/flip-<judgeSlug>-k<K>-<入力basename>` | `flip-deepseek-deepseek-v4-flash-k5-e2e-ollama-gemma3-4b.jsonl` |

- `judgeSlug` は `judge.name` から `[^a-z0-9]+` を `-` に置換したもの。

## 4. edge 候補モデル E2E 出力を judge にかける手順

1. **E2E 出力を生成**（別コマンド `eval:e2e` で実施。本手順書の範囲外）。
   - 入力: `routing-gold.jsonl`（35行）
   - 出力: `data/e2e-<model-slug>.jsonl`
   - 例: `data/e2e-ollama-granite-3-8b.jsonl`
2. **flip率モードで judge にかける**:
   ```bash
   OPENROUTER_API_KEY=... \
   JUDGE_MODEL=openai/gpt-4o \
   npm run eval:rejudge -w @hybrid/api -- data/e2e-ollama-granite-3-8b.jsonl --repeat 5
   ```
3. **出力を確認**: `data/flip-openai-gpt-4o-k5-e2e-ollama-granite-3-8b.jsonl`

## 5. 参照採点プロンプトの仕組み（`judge.ts`）

`judgeAnswer()` に `referencePoints`（文字列配列）を渡すと、参照採点プロンプトに自動切替:

- **参照なし**: 質問+回答のみで採点。judge の知識に依存。
- **参照あり**: `routing-gold.jsonl` の `referencePoints`（★=中心要点 / ★なし=補足要点）を採点基準として渡す。
  - ★中心要点をすべて満たせば `sufficient=true`。補足要点の欠落は `sufficient` に影響しない。
  - 言い回しの類似度は見ず、要点との矛盾/充足のみを判定。
- `referencePointsOf()`（`load.ts`）が承認ゲート: `answerReview` フィールドから承認済みの参照要点のみを返す。

## 6. 注意点

- **異judge間のgood率比較は禁止**。judgeが違えば採点基準が違う。flip率の傾向比較にとどめる。
- **flip率モードは温度非0必須**。温度0では判定が決定論的でflipが起きない。
- **cloud充填データは OpenRouter 経由**（直APIではない）。judge も OpenRouter 経由で統一すること。
- **入力JSONLのidはgold.idと同形（"gold-NN"）**。id一致で参照を引く（フォールバック: query正規化マッチ）。
