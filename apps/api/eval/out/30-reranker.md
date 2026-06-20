# 30: reranker 導入で検索精度を上げられるか

`2026-06-19 11:59` / elapsed=86s

## 背景

- out/29: 対称条件(N=1)で cloud real 46.3%、top-1 gid 含有率 65.9%
- 律速 = bge-m3 cosine の順位精度。自質問 chunk が他質問 chunk に上位を奪われる
- 本レポート: Workers AI bge-reranker-base で順位を矯正し、指標改善を検証

## 構成

- 粗選: bge-m3 cosine top-30 (embed cache 流用)
- rerank: `@cf/baai/bge-reranker-base` (Workers AI, GPU)
- cloud: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 全ref統一)
- oracle 基準: `rejudge-out26-verdicts.json` oracle_cloud (61.0%)

## Phase 1: 検索指標比較（生成不要）

| 指標 | bge-m3 cosine | reranker (bge-reranker-base) | 改善 |
|---|---|---|---|
| top-1 gid 含有率 | 27/41 = 65.9% | 22/41 = 53.7% | -12.2pt |
| top-3 gid 含有率 | 38/41 = 92.7% | 33/41 = 80.5% | -12.2pt |

### 判定: **reranker 無効** (top-1 gid 率 -12.2pt)。順位矯正では改善せず。
- → chunk粒度変更（1chunk粒度→質問単位/意味単位結合）が必要。embed再計算は避けられない。
