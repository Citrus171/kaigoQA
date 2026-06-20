# 47: 本番qaflow答案 judge（out/44完全同一judge + 2軸）

`2026-06-20 21:05` / elapsed=154s

## 目的

- 本番 `/ai/qa` 経由の答案を out/44 と完全同一のjudge（GPT-4o・全referencePoints統一・temp0）で採点
- out/44 eval経路 90.2% との対比により、生成経路（eval配線 vs 本番配線）の忠実性を検証
- relaxed/strict 2軸判定で実用KPIと専門的十分さを分離
- oracle非対称の停止条件を明記

## 構成
- judge model: openai/gpt-4o (OpenRouter, temp=0)
- 入力: `rag-mvp-edge-qaflow.jsonl`（41件、本番qaflow生成答案）
- 参照: gold-a全referencePoints（edge想定41件）
- judge: out/44 と完全同一の簡易prompt + 2軸relaxed/strict prompt の2系統

## 結果

### simple judge（out/44 完全同一）

- **本番qaflow good: 37/41 = 90.2%**
- out/44 実RAG edge good: 37/41 = 90.2%（基準）
- **差: +0.0pt**
- 生成経路の忠実性: ✅ 維持（差≦許容）

### 2軸 judge（relaxed / strict）

- **relaxed good（★核心要点のみ）: 37/41 = 90.2%** ← 実用KPI
- strict good（全要点網羅）: 24/41 = 58.5% ← 参考

### 応答時間（本番qaflow実測）

- avg=5138ms / p50=4220ms / p95=8795ms / max=24928ms

### 2×2: oracle vs qaflow

| | qaflow good | qaflow bad |
|---|---|---|
| **Oracle good** | 35 (検索も推論もOK) | 2 (retrieval failure) |
| **Oracle bad** | 2 (稀) | 2 (reasoning/capacity failure) |

- oracle good: 37/41 = 90.2%
- qaflow good: 37/41 = 90.2%
- retrieval loss: 90.2% → 90.2% (Δ=0.0pts)
- retrieval failure: 2/41 (4.9%)
- reasoning failure: 2/41 (4.9%)
- **不可解な逆転（oracle bad/qaflow good）: 2件 → oracle judge失敗 または qaflowがoracle超えの生成を偶然成功したケース**

### 不一致分析（out/44 vs qaflow のgood判定不一致）

- 判定不一致: 4件
  - qaflow→good / out44→bad: 2件
  - qaflow→bad / out44→good: 2件
- 回答本文差異あり: 41件（qaflow bad / out44 good: 2件）

### 全件内訳

| id | simple | relaxed | strict | simple reason | 2axis reason | answer同一 |
|---|---|---|---|---|---|---|
| gold-A-001 | . | . | . | 介護保険法成立年が欠落 | 1997年成立を欠落 | N |
| gold-A-002 | G | G | G | 正確で十分な回答 | 全要点を網羅している | N |
| gold-A-003 | G | G | G | 正確で詳細な回答 | 全要点を正確に網羅 | N |
| gold-A-004 | G | G | G | 要点を全て含む正確な回答 | 全要点を正確に網羅している | N |
| gold-A-005 | G | G | G | 正確で十分な回答 | 主要事実網羅し誤りなし | N |
| gold-A-006 | G | G | G | 要点を全て網羅している | 全要点を網羅している | N |
| gold-A-008 | G | G | . | 要点を全て含む正確な回答 | 補足情報が欠落しているため | N |
| gold-A-009 | . | G | G | 基準回数の詳細が過剰 | 全要点を網羅しているため | N |
| gold-A-010 | G | G | G | 要点を全て含む正確な回答 | 全要点を網羅している | N |
| gold-A-011 | G | G | G | 正確で十分な回答 | 全要点を正確に網羅 | N |
| gold-A-013 | G | G | G | 全要点を正確に含む | 全要点網羅 | N |
| gold-A-014 | G | G | G | 正確で十分な回答 | 全要点を正確に網羅 | N |
| gold-A-026 | G | G | G | 正確で要点を網羅している | 全要点を網羅している | N |
| gold-A-027 | G | G | G | 全要点を正確に含む | 全要点を網羅している | N |
| gold-A-028 | G | G | G | 全要点を正確に含む | 全要点を正確に網羅 | N |
| gold-A-029 | . | G | . | 費用説明が過剰 | 補足情報が欠落 | N |
| gold-A-030 | G | G | G | 全要点を正確に含む | 全要点を網羅している | N |
| gold-A-031 | G | G | G | 要点を全て含む正確な回答 | 全要点を正確に網羅 | N |
| gold-A-032 | G | G | G | 要点を全て含む正確な回答 | 全要点網羅し誤りなし | N |
| gold-A-033 | G | G | G | 正確で十分な回答 | 全要点を網羅しているため | N |
| gold-A-037 | G | G | . | 正確で十分な情報を提供 | 補足情報が欠落しているため | N |
| gold-A-038 | G | G | G | 全要点を正確に含む | 全要点網羅し誤りなし | N |
| gold-A-039 | G | G | . | 要点を全て含んでいる | 補足情報が欠落しているため | N |
| gold-A-040 | G | G | . | 要点を全て含んでいる | 補足情報が欠落しているため | N |
| gold-A-041 | . | . | . | 老健の要件が不足 | 老健の要件と複数申込が欠落 | N |
| gold-A-042 | G | G | G | 正確で十分な回答 | 全要点を網羅している | N |
| gold-A-060 | G | . | . | 正確で十分な情報 | 継続利用可否の情報欠落 | N |
| gold-A-085 | G | G | G | 要点を網羅している | 全要点を網羅している | N |
| gold-A-086 | G | G | G | 要点を全て含む正確な回答 | 全要点網羅し誤りなし | N |
| gold-A-087 | G | G | . | 要点を全て含む正確な回答 | 補足情報が不足しているため | N |
| gold-A-088 | G | . | . | 要点を全て含む正確な回答 | 全要点を正確に網羅 | N |
| gold-A-089 | G | G | . | 要点を網羅している | 補足情報が不足しているため | N |
| gold-A-090 | G | G | G | 要点を全て含む正確な回答 | 全要点を正確に網羅 | N |
| gold-A-091 | G | G | . | 要点を全て含む正確な回答 | 補足情報が欠落しているため | N |
| gold-A-092 | G | G | . | 要点を正確に網羅 | 補足情報が欠落しているため | N |
| gold-A-097 | G | G | G | 全要点を正確に含む | 全要点を正確に網羅 | N |
| gold-A-098 | G | G | . | 要点を全て含む正確な回答 | 補足情報が欠落しているため | N |
| gold-A-099 | G | G | . | 要点を全て含む正確な回答 | 補足情報が欠落している | N |
| gold-A-102 | G | G | . | 要点を全て含む正確な回答 | 補足情報が欠落している | N |
| gold-A-103 | G | G | G | 要点を網羅し正確 | 主要事実を全て網羅している | N |
| gold-A-115 | G | G | . | 要点を網羅している | 補足情報が欠落しているため | N |

## oracle非対称の停止条件

oracle good ≠ qaflow good の非対称が生じる場合、以下の停止条件で原因を特定しそれ以上追わない:

| パターン | 意味 | 停止条件 |
|---|---|---|
| oracle=good / qaflow=bad | retrieval failure（検索品質問題） | oracle注入すれば正答できるので、**生成モデルの推論能力に問題なし**。検索側（embed/rerank/k）のチューニングに注力。 |
| oracle=bad / qaflow=good | 不可解な逆転 | **oracle judgeの採点ミス または oracle=goodの基準以下でqaflowが偶然良い回答を生成**。oracle verdictを再検証し、明らかな誤判定ならoracle回答を再生成。改善しなければそれ以上追わない（oracleの理論上限ではない実測上限として扱う）。 |
| oracle=bad / qaflow=bad | reasoning/capacity failure（生成モデルの能力限界） | oracle注入でも不正解なので、**検索の良し悪し以前にモデル能力の問題**。プロンプト改善・より強力なモデルへの変更を検討。qaflow側の改善では解決不可。 |
| oracle=good / qaflow=good | 理想状態 | 検索・推論とも問題なし。停止。 |

### 今回の2x2に対する停止判断

- **retrieval failure 2件**: 検索品質の改善余地あり。該当: `['gold-A-009', 'gold-A-029']`
- **reasoning failure 2件**: モデル能力限界。プロンプト/モデル変更を検討。該当: `['gold-A-001', 'gold-A-041']`
- **不可解な逆転 2件**: oracle verdict検証要。該当: `['gold-A-060', 'gold-A-115']`

## 考察

- **生成経路の忠実性**: out/44 eval経路 90.2% に対し本番qaflow 90.2%。差 +0.0pt。
- ✅ **eval経路と本番経路で生成品質は同等**。配線（/ai/qaエンドポイント→RAG→生成→回答）はeval配線（out44.py→retrieval→gen）と同等の答案を生んでいる。

- **実用KPI（relaxed）: 90.2%**。一次対応アシスタントとしての実用性。
- strict → relaxed の改善幅: +31.7pt（条文番号・付随細目の許容による）