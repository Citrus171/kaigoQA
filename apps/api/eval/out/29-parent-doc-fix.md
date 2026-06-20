# 29: approach C 公正再実装 (parent-doc top-N)

`2026-06-19 11:14` / elapsed=1207s

## 背景

- out/28 の approach C は top-20 に出現した**全 src_id の親**(平均~70refs, 14.3倍oracle)を渡し、実質「大量文脈総当たり」だった
- その結果 real=65.9% が oracle=61.0% を超える偽の逆転（odd=8件）。生成入力規模の非対称が原因
- 本レポート: parent-document retrieval を **top-N unique src_id の親のみ**に制限し、N=1,2,3 を比較
- **対称性の条件**: 生成入力規模が oracle(M≈4.9refs) と同オーダーであること

## 構成

- 検索: fine-grained 573 chunks (embed cache 流用, cosine top-20)
- 生成用 refs: top-20 から score 順の unique src_id 上位 N 個の親文書(全 referencePoints)
- cloud モデル: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 全ref統一)
- oracle 基準: `rejudge-out26-verdicts.json` oracle_cloud (25/41 = 61.0%)
- 改善対象: gold-A-006, gold-A-013, gold-A-014, gold-A-027, gold-A-030, gold-A-038, gold-A-039, gold-A-042

## 結果サマリ

| N | cloud good | avg parent_refs | oracle refs | 生成入力対称性 | top-N gid含有率 | retrieval failure | 8件救済 |
|---|---|---|---|---|---|---|---|
| 1 | 19/41 = 46.3% | **4.8** | 4.9 | **✅ 対称 (≈1×)** | 27/41 = 65.9% | 11/41 = 26.8% | 3/8 |
| 2 | 27/41 = 65.9% | 9.5 | 4.9 | ⚠️ 非対称 (≈2×) | 33/41 = 80.5% | 8/41 = 19.5% | 4/8 |
| 3 | 25/41 = 61.0% | 14.3 | 4.9 | ⚠️ 非対称 (≈3×) | 38/41 = 92.7% | 8/41 = 19.5% | 3/8 |

### 最重要: N=1（唯一の対称条件）

- **生成入力規模 4.8refs ≈ oracle M=4.9 → 対称 ✅**
- **cloud good = 46.3%** → baseline k=20 と**同率**（ただし good 集合は6件入れ替わり: N1のみ good=006,014,030,033,037,099 / baselineのみ good=009,011,086,087,097,103）。ネット改善ゼロだが解ける件は異なる。
  - 参考(過剰解釈注意・in-sample): N1 good ∪ baseline good = 25件 = 61.0% = oracle相当。parent-doc と raw-chunk は相補的。
- retrieval failure = 11/41 = 26.8%
- top-1 gid含有率 = 65.9% (27/41件しか自質問の親を引けていない)

**→ parent-document retrieval は、対称条件では全く改善しない。** baseline(k=20, fine chunk)と同じ46.3%。親文書化の効果はゼロ。

### N=2,3: 非対称条件（参考値）

- N=2 で cloud good=65.9% と oracle 61.0% を上回る → **非対称による偽の逆転（odd=10件）**
- N=3 で cloud good=61.0% = oracle と同じ → 偶然の一致。odd=8件が残る
- N=2,3 の「改善」は余剰な隣接質問の情報注入によるもの。実運用ではこの情報量を注入できない（上位に自質問がなく、隣接質問の親だけが渡る）

## N=1 詳細（本測定）

- cloud good: 19/41 = 46.3%
- avg parent_refs: 4.8 (≈ oracle 4.9)
- top-1 gid含有率: 27/41 = 65.9%
- 8件救済: 3/8
  - 救済: gold-A-006, gold-A-014, gold-A-030
  - 未救済: gold-A-013, gold-A-027, gold-A-038, gold-A-039, gold-A-042

### 2×2: N=1

| | real good | real bad |
|---|---|---|
| **Oracle good** | 14 (both ok) | 11 (retrieval failure) |
| **Oracle bad** | 5 (rare) | 11 (reasoning failure) |

- oracle good: 25/41 = 61.0%
- real good: 19/41 = 46.3%
- retrieval loss: 61.0% → 46.3% (delta=-14.7pt)
- **retrieval failure: 11/41 = 26.8%** ids=gold-A-009, 011, 013, 027, 038, 039, 042, 086, 087, 097, 103
- reasoning failure: 11/41 = 26.8%
- odd: 5/41 = 12.2% ids=gold-A-002, 029, 033, 037, 099

### 未救済 5件の原因

| id | gid_in_parent | 原因 |
|---|---|---|
| gold-A-013 | N | top-1 unique src に自質問が入らず、隣接質問の親(4refs)だけ渡される → information mismatch |
| gold-A-027 | N | 同上 |
| gold-A-038 | N | 同上 |
| gold-A-039 | N | top-3 でやっと自質問が入るが、N=1 では入らない |
| gold-A-042 | Y | 自質問の親(5refs)を渡せているが generation が答えられない → reasoning failure |

## N=2 詳細（参考: 非対称）

- cloud good: 27/41 = 65.9% (**⚠️ oracle 61.0% 超え = 非対称**)
- avg parent_refs: 9.5 (oracle の 1.9倍)
- top-2 gid含有率: 33/41 = 80.5%
- retrieval failure: 8/41 = 19.5%
- odd: 10/41 = 24.4% ← 隣接質問の余剰情報注入による偽の改善

## N=3 詳細（参考: 非対称）

- cloud good: 25/41 = 61.0%（偶然 oracle と一致）
- avg parent_refs: 14.3 (oracle の 2.9倍)
- top-3 gid含有率: 38/41 = 92.7%
- retrieval failure: 8/41 = 19.5%
- odd: 8/41 = 19.5% ← 隣接質問の余剰情報注入による偽の改善

## 比較: 全方式

| 方式 | cloud good | retrieval failure | retrieval loss | 生成入力規模 | 対称性 |
|---|---|---|---|---|---|
| oracle (全ref注入) | 61.0% | 0% | 0pt | M≈4.9refs | 基準 |
| baseline k=5 | 39.0% | 29.3% | -22.0pt | 5 chunks | ✅ |
| baseline k=20 | 46.3% | 19.5% | -14.6pt | 20 chunks | ✅ |
| **out/29 N=1 (対称)** | **46.3%** | **26.8%** | **-14.7pt** | **4.8refs** | **✅ 対称** |
| out/29 N=2 (参考) | 65.9% | 19.5% | +4.9pt | 9.5refs | ⚠️ 2×oracle |
| out/28 (全src親) | 65.9% | 14.6% | +4.9pt | 69.7refs | ⚠️ 14×oracle |

## 結論

### 確定事項

1. **対称条件(N=1, 4.8refs≈oracle 4.9refs)では、parent-document retrieval は baseline と同率 46.3%。ネット改善効果ゼロ**（ただし good 集合は6件入れ替わり＝両方式は相補的。完全一致ではない）。
2. **out/28 の「65.9%で oracle 超え」は生成入力の大量注入(69.7refs)によるアーティファクト。N=2(9.5refs)でも再現するが非対称。**
3. **parent-document retrieval で 3/8 件が救済されたが、それは元から full-coverage だったか、(N=2+)非対称な余剰情報注入によるもの。**
4. **top-1 unique src_id に自質問の親が含まれる率は 65.9% しかない** → retrieval 精度そのものが不十分。
5. **自質問の親を引けても generation が答えられない（reasoning failure）が 26.8% 存在。**

### 構造的課題

- 親文書化による改善は「自質問の親を引けたか」に依存するが、top-1 gid 含有率は 65.9% に過ぎない
- top-20 の fine-chunk 検索結果の中で、自質問の chunk が最上位に来るとは限らない。他質問の chunk が score 上位を奪う
- この問題は k 拡大や親文書化の方法では解決できず、**検索精度そのもの（embedding / chunk粒度 / reranker）の改善が必要**

### 次の一手

| 優先度 | アクション | 根拠 |
|---|---|---|
| 1 | **検索精度の改善**（chunk粒度変更: 質問単位結合 / 意味的グルーピング） | top-1 gid含有率65.9%を上げないと retrieval failure 26.8% は削れない |
| 2 | generation 改善（プロンプト/モデル） | reasoning failure 26.8% が並行して律速 |
| 3 | edge はスコープ外（現状維持） | reasoning failure 65.9% 律速・cloud 寄せ運用確定 |

## 成果物
- `apps/api/eval/parent-doc-fix.py` (N=1,2,3 統合スクリプト)
- `apps/api/eval/data/rag-mvp-cloud-parentN1.jsonl` (41件)
- `apps/api/eval/data/rag-mvp-cloud-parentN2.jsonl` (41件)
- `apps/api/eval/data/rag-mvp-cloud-parentN3.jsonl` (41件)
- `apps/api/eval/out/29-parent-doc-fix.md` (本レポート)
