# 26: 実RAG MVP retrieval評価結果

`2026-06-19 09:33` / elapsed=1686s

## 構成
- corpus: 573 chunks (120質問の全referencePoints)
- embed: bge-m3 (ollama, dim=1024)
- 検索: cosine top-k (k=5)
- edge model: Gemma4 26B thinkOFF (Workers AI)
- cloud model: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, 参照あり)
- 評価対象: edge想定41件


## recall@k

| k | recall |
|---|--------|
| 3 | 38/41 = 92.7% |
| 5 | 39/41 = 95.1% |
| 8 | 41/41 = 100.0% |

## retrieval 結果（生成用 k=5）

- edge: 19/41 = 46.3% good (hit rate=39/41=95.1%)
- cloud: 25/41 = 61.0% good (hit rate=39/41=95.1%)


## 2×2: Edge (Gemma4 thinkOFF)

| | 実RAG good | 実RAG bad |
|---|---|---|
| **Oracle good** | 8 (検索も推論もOK) | 7 (retrieval failure) |
| **Oracle bad** | 11 (稀) | 15 (reasoning/capacity failure) |

- oracle good: 15/41 = 36.6%
- 実RAG good: 19/41 = 46.3%
- retrieval loss: 36.6% → 46.3% (Δ=9.8pts)
- retrieval failure (検索で引けず劣化): 7/41 = 17.1%
- reasoning failure (モデル限界): 15/41 = 36.6%


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

- edge: oracle 36.6% → 実RAG 46.3% (retrieval loss=9.8pts)
  - retrieval failure: 7/41 (17.1%)
  - reasoning failure: 15/41 (36.6%)
- cloud: oracle 63.4% → 実RAG 61.0% (retrieval loss=2.4pts)
  - retrieval failure: 8/41 (19.5%)
  - reasoning failure: 8/41 (19.5%)

## ⚠️ 上記の本文数値は無効（2026-06-19 検算で判明）

**本文（## retrieval結果 / ## 2×2 / ## 考察）の retrieval loss・実RAG good・2×2は判定軸の非対称により無効。正は下の「再測定」節を参照。**

非対称の正体: 元の judge は oracle=全referencePoints採点（phaseA過去run）/ 実RAG=**retrievalした上位k参照のみで採点**（`rag-mvp.py` L265, refs=top-k）。judge は temperature=0 なので揺らぎでなく**系統差**。edge の逆転(実RAG 46.3%>oracle 36.6%)の主因 odd=11件は**全件 `oracle=partial`→`real=ok` の一方向シフト**（逆方向0）で、judge に渡す参照が retrieval版 vs 全版で非対称だったことが原因。

なお **retrieval 品質指標（recall@k / hit）自体は有効**: recall@5=95.1% / recall@8=100% / hit=39/41。

## 再測定（2026-06-19・正）: 同一judge・全referencePoints統一

`rejudge-out26.py` で 4系統（oracle/real × edge/cloud）の**答案を据え置き**、judge に渡す参照を全 referencePoints(gold) に統一して 164件再採点（gpt-4o, temp=0）。verdict は `data/rejudge-out26-verdicts.json`。

| | oracle good | 実RAG good | retrieval loss | retrieval failure | reasoning failure | odd(逆転) |
|---|---|---|---|---|---|---|
| **EDGE**  | 13/41=31.7% | 6/41=**14.6%** | **−17.1pt** | 7/41=17.1% | 28/41=68.3% | **0** |
| **CLOUD** | 25/41=61.0% | 16/41=**39.0%** | **−22.0pt** | 12/41=29.3% | 13/41=31.7% | 3/41=7.3% |

### 結論（再測定後・本文と差し替え）
- **判定軸を揃えると edge の逆転 odd=11→0 に消滅** → 元の「retrieval改善(+9.8pt)」は判定非対称アーティファクトと確定。
- **真の retrieval loss は大きい**: edge −17.1pt / cloud −22.0pt。RAG(k=5)は oracle(全ref注入)に対し実質的に大きく劣化。
- **「retrievalは本筋でない」は誤り**。真因は **recall@kの定義（正解srcが1つでもtop-kに入ればhit）と judge の sufficient 基準（全要点カバー要求）の不整合**。recall@5=95.1%でも k=5では全要点を揃えられず答案が情報不足→全ref基準で bad。**retrievalの網羅性が律速**。
- → 次の投資先は retrieval改善（k拡大・網羅性・チャンク設計）と generation の双方。selective-routing の天井議論も本表の値で引き直すこと。
