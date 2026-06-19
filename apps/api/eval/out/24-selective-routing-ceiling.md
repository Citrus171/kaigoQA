# Selective Capability Routing 天井（oracle）試算

**日時**: 2026-06-18（2026-06-19 同一judge再測定を追記）
**関連**: [[22-phase-b-slo-definition]] [[23-slo1-cloud-baseline]]

> ## ⚠️ 2026-06-19 再測定の結論（先に読む）
>
> 本書のedge good(`phaseA new_good`)とcloud good(`measA good`)は**別run判定**で、out/26で暴いたのと同種の判定軸非対称を含む。`rejudge-out26.py` で4系統を**同一judge・全referencePoints**で再採点し引き直した結果:
>
> | 条件 | all-edge | all-cloud | selective天井(e∨c) | offload |
> |---|---|---|---|---|
> | **oracle**(全ref注入) | 31.7% | 61.0% | **70.7%** (+9.8pt) | 31.7% |
> | **real**(retrieval k=5) | 14.6% | 39.0% | **39.0%** (+0.0pt) | 14.6% |
>
> - **oracle天井70.7%は頑健**（再採点でも不変。本書の核心は生き残る）。
> - **だが retrieval条件では selective優位が消滅**: real-selective天井=39.0%=real all-cloudと同値。real_edge good(6件)が全て real_cloud good(16件)に内包され**edge上乗せ=0件**。retrievalが天井を**−31.7pt**削る。
> - → 「selective routing成立(+7.3pt)」は**全ref注入oracleの前提**でのみ真。現実のretrieval(k=5)下では不成立。**retrieval網羅性の改善が全ての前提**（[[selective-routing-pivot]] / out/26参照）。

## 背景

- out/22: SLO 凍結。SLO-1 = edge振り分け分 good率 ≥ always-cloud − 5pt（品質最優先）。
- out/23: cloud baseline 測定。always-cloud(参照なし)=7.5% / cloud+RAG=63.4% / edge(Gemma4 26B+RAG)=36.6%。
  → ケースB（同RAG下のモデル能力差）で edge は cloud に **−26.8pt**。**edge 全振りは SLO-1 未達**。
- **本書**: ならば「edge が確実に good な件だけ edge、不確実は cloud へ escalate」する **selective capability routing** の**理論上限（oracle）**を試算し、設計が成立するか判定する。

## データソース（edge候補=gold-a `expected=="edge"` の41件）

| 役割 | ファイル | フィールド |
|------|----------|-----------|
| edge 件別 good | `phaseA-gemma4-incontext-results-edge-thinkoff.json` | `items[].id`, `items[].new_good` |
| cloud+RAG 件別 good | `measA-cloud-rag-edge.jsonl` | `id`, `good` |

両ファイル41件・`id` で1:1 join。採点はいずれも gpt-4o judge・参照あり（同一基準）。

## 測定結果

各件 `e = edge_good`, `c = cloud_good`（41件合計 edge=15, cloud=26）。

| 戦略 | 定義 | good率 | offload（edge利用率） |
|------|------|--------|----------------------|
| all-edge | 全件 edge（Gemma4 thinkOFF + RAG） | 15/41 = **36.6%** | 100% |
| all-cloud+RAG | 全件 cloud（deepseek-v4-flash + RAG） | 26/41 = **63.4%** | 0% |
| **oracle-selective** | e=True→edge, それ以外→cloud（完全予測器） | 29/41 = **70.7%** | **36.6%**（15/41） |

- oracle-selective good = `Σ(e ∨ c)` = 29件。offload = `Σ(e) / 41` = 15/41 ≈ 36.6%。
- quality 変化 vs. always-cloud(+RAG): 63.4% → 70.7% = **+7.3pt**（offload 37% を稼ぎつつ品質は cloud 以上）。

### クロス集計

| 区分 | 件数 | 割合 | 含意 |
|------|------|------|------|
| edge=True, cloud=True | 12 | 29.3% | 両方good＝edgeで肩代わり可（コスト削減の核） |
| edge=True, cloud=False | 3 | 7.3% | **edgeのみgood**＝edge固有価値（限定的） |
| edge=False, cloud=True | 14 | 34.1% | **cloudのみgood＝escalate必須**（最大カテゴリ、selectiveで拾う本丸） |
| edge=False, cloud=False | 12 | 29.3% | **両方bad**＝RAGでも両者解けない構造的難所（routingでは救えない） |

## 解釈

1. **selective routing は成立する。** oracle 天井 = offload 37% で品質 cloud 超え(+7.3pt)。完全予測器が前提のため、現実は confidence 予測器の精度次第で 70.7% から劣化する。
2. **両方bad 29.3%** = edge候補ですら約3割は誰も解けない。routing 以前に**参照/データ品質 or 採点厳しさ**の課題が残る。
3. **edge固有good=3件のみ** = edge の存在意義は品質向上ではなく**コスト削減**（SLO-3との整合を再確認）。

## 次タスク

- **confidence 予測器の設計**: どのシグナル（埋め込み類似度・カテゴリ・回答長・self-consistency 等）で `edge_good` を事前判定するか。oracle 70.7% にどこまで迫れるかが本丸。
- 関連: [[edge-quality-ceiling-gemma3]] [[gpu-e2e-edge-cloud-split]]
