# 44: edge(Gemma4 thinkOFF+V2) 本番基盤 実RAG k=3 測定

`2026-06-20 14:17` / elapsed=768s

## 構成
- corpus: 本番 `models/rag/corpus.json` (135 chunks, 1質問1chunk連結)
- embed: CF bge-m3 (@cf/baai/bge-m3, dim=1024)
- 検索: cosine top-k (k=3)
- edge model: Gemma4 26B thinkOFF+V2 (Workers AI)
- cloud model: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 全referencePoints統一)
- 対象: edge想定 (41件)

## layer 0: 基盤一致の検算

- top-1 gid 率: **95.1%** (out/31: 95.1%)

## retrieval 結果 (k=3)

- edge: 37/41 = 90.2% good (hit rate=41/41=100.0%)
- gen空答案: 0/41 = 0.0%
- latency(edge): avg=1801ms / p50=1718ms / p95=2850ms / max=3509ms
- cloud: 35/41 = 85.4% good (hit rate=41/41=100.0%)
- latency(cloud): avg=8980ms / p50=8264ms / p95=17643ms / max=20866ms
- oracle: 37/41 = 90.2% good
- latency(oracle): avg=1834ms / p50=1444ms / p95=2772ms / max=9627ms

## 2×2: Edge (Gemma4 thinkOFF+V2)

| | 実RAG good | 実RAG bad |
|---|---|---|
| **Oracle good** | 34 (検索も推論もOK) | 3 (retrieval failure) |
| **Oracle bad** | 3 (稀) | 1 (reasoning/capacity failure) |

- oracle good: 37/41 = 90.2%
- 実RAG good: 37/41 = 90.2%
- retrieval loss: 90.2% → 90.2% (Δ=0.0pts)
- retrieval failure: 3/41 (7.3%)
- reasoning failure: 1/41 (2.4%)


## 2×2: Cloud (deepseek-v4-flash)

| | 実RAG good | 実RAG bad |
|---|---|---|
| **Oracle good** | 33 (検索も推論もOK) | 4 (retrieval failure) |
| **Oracle bad** | 2 (稀) | 2 (reasoning/capacity failure) |

- oracle good: 37/41 = 90.2%
- 実RAG good: 35/41 = 85.4%
- retrieval loss: 90.2% → 85.4% (Δ=4.9pts)
- retrieval failure: 4/41 (9.8%)
- reasoning failure: 2/41 (4.9%)

## 考察

- 基盤一致: top-1 gid 95.1% (out/31 95.1% 比)
- edge thinkOFF+V2 実RAG: 37/41 = 90.2% good
- 空答案率: 0/41 = 0.0% (out43 thinkON: 9.8%)
- cloud flash 実RAG: 35/41 = 85.4% good