# RAG MVP 再開メモ (2026-06-19)

## 前日までの成果

- `apps/api/eval/rag-mvp.py` 完成（layer1/2/3 統合スクリプト）
- corpus: 全120質問の referencePoints 573 chunk
- ollama bge-m3 起動確認済み（localhost:11434）
- bge-m3 embed 速度: 100件約190秒 → 全573件約19分（CPU）
- oracle RAG 既知の数値（2×2比較用読み込み実装済み）:
  - edge (Gemma4 thinkOFF): 15/41 = 36.6%
  - cloud (deepseek-v4-flash): 26/41 = 63.4%

## 実行結果 (2026-06-19)

### Layer 1: embed + recall@k ✓
- 実embed: 573 chunks, 1210s (~20分, 初回のみ)
- キャッシュ: `data/rag-corpus-embeddings.json` (7.9MB)
- recall@3: 38/41 = 92.7%
- recall@5: 39/41 = 95.1%
- recall@8: 41/41 = 100.0%

### Layer 2+3: 生成＋判定＋2×2 ✓
- 経過: 1686s (~28分, キャッシュ再利用でembedはスキップ)
- edge (Gemma4 thinkOFF): 19/41 = 46.3% (oracle比 +9.8pts)
- cloud (deepseek-v4-flash): 25/41 = 61.0% (oracle比 -2.4pts)

### 2×2故障分離

| | Edge | Cloud |
|---|---|---|
| oracle good | 15/41 = 36.6% | 26/41 = 63.4% |
| 実RAG good | 19/41 = 46.3% | 25/41 = 61.0% |
| retrieval failure | 7/41 = 17.1% | 8/41 = 19.5% |
| reasoning failure | 15/41 = 36.6% | 8/41 = 19.5% |
| retrieval loss | **+9.8pts** (改善) | -2.4pts |

### 出力ファイル
- `data/rag-mvp-edge.jsonl` (41件)
- `data/rag-mvp-cloud.jsonl` (41件)
- `out/26-rag-mvp-result.md` (最終レポート)

### 保留: 機械検算（ユーザー自身で）
- recall@k, retrieval loss, 2×2 を検算
- out/26 確定
