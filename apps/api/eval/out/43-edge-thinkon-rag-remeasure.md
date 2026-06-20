# 43: edge(Gemma4 thinkON+V2) 実RAG k=5 再測定

`2026-06-20 13:51` / elapsed=1342s

## 構成
- corpus: 670 chunks (135質問の全referencePoints)
- embed: bge-m3 (ollama, dim=1024)
- 検索: cosine top-k (k=5)
- edge model: Gemma4 26B thinkON+V2 (Workers AI)
- cloud model: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, 参照あり)
- 評価対象: edge想定41件


## recall@k

| k | recall |
|---|--------|
| 3 | 26/41 = 63.4% |
| 5 | 27/41 = 65.9% |
| 8 | 29/41 = 70.7% |

## retrieval 結果（生成用 k=5）

- edge: 24/41 = 58.5% good (hit rate=27/41=65.9%)
- cloud: 25/41 = 61.0% good (hit rate=39/41=95.1%)


## 2×2: Edge (Gemma4 thinkON+V2)

| | 実RAG good | 実RAG bad |
|---|---|---|
| **Oracle good** | 23 (検索も推論もOK) | 16 (retrieval failure) |
| **Oracle bad** | 1 (稀) | 1 (reasoning/capacity failure) |

- oracle good: 39/41 = 95.1%
- 実RAG good: 24/41 = 58.5%
- retrieval loss: 95.1% → 58.5% (Δ=36.6pts)
- retrieval failure (検索で引けず劣化): 16/41 = 39.0%
- reasoning failure (モデル限界): 1/41 = 2.4%


## 2×2: Cloud (deepseek-v4-flash)

| | 実RAG good | 実RAG bad |
|---|---|---|
| **Oracle good** | 18 (検索も推論もOK) | 8 (retrieval failure) |
| **Oracle bad** | 7 (稀) | 8 (reasoning/capacity failure) |

- oracle good: 26/41 = 63.4%
- 実RAG good: 25/41 = 61.0%
- retrieval loss: 63.4% → 61.0% (Δ=2.4pts)
- retrieval failure (検索で引けず劣化): 8/41 = 19.5%
- reasoning failure (モデル限界): 8/41 = 19.5%

## 考察

- edge: oracle 95.1% → 実RAG 58.5% (retrieval loss=36.6pts)
  - retrieval failure: 16/41 (39.0%)
  - reasoning failure: 1/41 (2.4%)
- cloud: oracle 63.4% → 実RAG 61.0% (retrieval loss=2.4pts)
  - retrieval failure: 8/41 (19.5%)
  - reasoning failure: 8/41 (19.5%)
