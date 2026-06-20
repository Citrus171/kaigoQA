# 27: retrieval 網羅性の定量化と k 掃引

`2026-06-19 10:09`

## 背景

- out/26 再測定: 実RAG(k=5)の retrieval loss は edge -17.1pt / cloud -22.0pt
- 真因: recall@k定義(1hit)と judge sufficient(全要点)の不整合
- 本レポート: recall を再定義し k 掃引で retrieval 網羅性と律速を定量化

## 構成

- corpus: 573 chunks（全120質問の全referencePoints＝検索空間。embed cache流用）/ 評価対象=edge想定41質問
  - ※初版に「200 chunks」と誤記。実際の検索は573 chunk空間（embed cache 573と整合を検算で確認済）。coverage/good率は573空間の値で正。
- embed: bge-m3 (ollama, dim=1024) - キャッシュ流用
- 検索: cosine top-k, k sweep {5,8,12,16,20,30}
- 評価対象: edge 想定 41件
- judge: openai/gpt-4o (OpenRouter, temp=0, **全ref統一**)
- oracle verdict: `rejudge-out26-verdicts.json`（全ref統一採点済み）

## M_i 分布（質問ごとの referencePoints 数）

- min=4, max=6, median=5, mean=4.9

| M_i | count |
|-----|-------|
| 4 | 9 |
| 5 | 28 |
| 6 | 4 |

## Phase 1: k sweep 3 metrics（生成不要）

| k | hit-rate@k (現定義) | coverage@k (平均要点カバー率) | full-coverage@k (全要点揃い率) |
|---|---|---|---|
| 5 | 39/41 = 95.1% | 46.8% | 1/41 = 2.4% |
| 8 | 41/41 = 100.0% | 56.1% | 3/41 = 7.3% |
| 12 | 41/41 = 100.0% | 62.7% | 6/41 = 14.6% |
| 16 | 41/41 = 100.0% | 65.7% | 8/41 = 19.5% |
| 20 | 41/41 = 100.0% | 66.6% | 8/41 = 19.5% |
| 30 | 41/41 = 100.0% | 70.5% | 9/41 = 22.0% |

### 指標の定義

- **hit-rate@k**: 質問の referencePoints のうち1個でも top-k に入った質問率（現 recall 定義・比較用）
- **coverage@k**: 平均 `hit_i / M_i`（全要点のうち何割が top-k に入ったか）
- **full-coverage@k**: `hit_i == M_i`（全要点が揃った）質問率（judge sufficient に最も近い）

### Phase 1 考察

- recall@5=95.1%(hit-rate) に対し full-coverage@5=**2.4%**（1/41件しか全要点が揃わない）
- この差が out/26 再測定の retrieval loss (edge -17.1pt / cloud -22.0pt) の機械的説明: **k=5 では各質問の全要点が揃わず、答案が情報不足になる**
- full-coverage は k=16 で 19.5% に頭打ち。k=30 でも 22.0% → **チャンク1点単位の粒度では全要点を揃えるのに限界がある**（同一 src の chunk が cosine で離散する、他 src の chunk が top-k を奪う）
- coverage は k=5 で 47% → k=20 で 67% → k=30 で 71%。平均的に約3割の要点がこぼれる

## Phase 2: k=20 生成検証

- edge model: Gemma4 26B thinkOFF (Workers AI)
- cloud model: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 全ref統一)
- oracle verdict: rejudge-out26-verdicts.json（全ref統一、同一judge）
- 生成用 k=20, 評価用 n=41件

### 2×2: EDGE (Gemma4 thinkOFF), k=20

| | real good | real bad |
|---|---|---|
| **Oracle good** | 8 (both ok) | 5 (retrieval failure) |
| **Oracle bad** | 1 (rare) | 27 (reasoning failure) |

- oracle good: 13/41 = 31.7%
- real good: 9/41 = 22.0%
- retrieval loss: 31.7% → 22.0% (delta=-9.8pt)
- retrieval failure: 5/41 = 12.2%  ids=gold-A-008, gold-A-014, gold-A-037, gold-A-092, gold-A-097
- reasoning failure: 27/41 = 65.9%
- odd: 1/41 = 2.4%  ids=gold-A-085

### 2×2: CLOUD (deepseek-v4-flash), k=20

| | real good | real bad |
|---|---|---|
| **Oracle good** | 17 (both ok) | 8 (retrieval failure) |
| **Oracle bad** | 2 (rare) | 14 (reasoning failure) |

- oracle good: 25/41 = 61.0%
- real good: 19/41 = 46.3%
- retrieval loss: 61.0% → 46.3% (delta=-14.6pt)
- retrieval failure: 8/41 = 19.5%  ids=gold-A-006, gold-A-013, gold-A-014, gold-A-027, gold-A-030, gold-A-038, gold-A-039, gold-A-042
- reasoning failure: 14/41 = 34.1%
- odd: 2/41 = 4.9%  ids=gold-A-002, gold-A-029

### k=5（out/26再測定）→ k=20（本測定）比較

| | k=5 | k=20 | delta | retrieval failure (k=5→k=20) |
|---|---|---|---|---|
| edge good | 14.6% | 22.0% | **+7.4pt** | 7→5件 (17.1%→12.2%) |
| cloud good | 39.0% | 46.3% | **+7.3pt** | 12→8件 (29.3%→19.5%) |

### real-selective 天井 (k=20)

- real-cloud 46.3% vs real-edge 22.0%
- selective 上乗せ幅: **+24.3pt**（cloud 側へルーティングする価値あり）
- cf. k=5 時: real-cloud 39.0% vs real-edge 14.6% → selective +24.4pt（ほぼ不変）

## 結論

### 確定したこと

1. **k 拡大は有効。retrieval 網羅性が律速の一部であることが定量的に確認できた。**
   - k=5→20 で両モデルとも **+7.3〜7.4pt 改善**
   - retrieval failure は edge 5件減 / cloud 4件減

2. **しかし retrieval 網羅性だけでは解決しない**
   - edge oracle good=31.7% に対して real good=22.0%（-9.8pt）
   - cloud oracle good=61.0% に対して real good=46.3%（-14.6pt）
   - oracle との差の大半は retrieval failure でなく **reasoning failure 由来**

3. **reasoning failure が真の天井**
   - edge: **65.9%**（27/41）が reasoning failure
   - cloud: **34.1%**（14/41）が reasoning failure
   - retrieval failure は edge 12.2% / cloud 19.5% → generation 限界の方がはるかに大きい

4. **full-coverage の頭打ち（k=16〜30 で 19.5%→22.0%）**
   - チャンク 1点単位の粒度では全要点を揃えるのに構造的限界がある
   - 同一 src の複数 chunk が cosine で離散し、他 src の chunk に top-k を奪われる

### 次の一手候補

| 優先度 | アクション | 根拠 |
|---|---|---|
| 1 | **チャンク設計の見直し**（referencePoint 結合・階層化） | full-coverage 頭打ちの根本原因。k拡大だけでは越えられない壁 |
| 2 | **generation 改善**（プロンプト最適化、推論強化） | reasoning failure が edge 65.9% / cloud 34.1% と支配的 |
| 3 | #08 Dataset 拡充 | 評価系が固まった後の信頼性向上 |

## 成果物
- `apps/api/eval/retrieval-coverage.py`（Phase1+2 統合スクリプト）
- `apps/api/eval/data/rag-mvp-edge-k20.jsonl`（41件）
- `apps/api/eval/data/rag-mvp-cloud-k20.jsonl`（41件）
- `apps/api/eval/out/27-retrieval-coverage.md`（本レポート）
