# 22 Phase B: SLO 定義（凍結）＋ thinking on/off 検証

2026-06-18 起票。`out/21`（Gemma4+RAG が本命）を受け、本番化の合格基準（SLO）を凍結する。
レビュー指摘「SLO を Phase B 冒頭で凍結しないと"完了"が定義できない」を反映。

## 凍結 SLO（ユーザー判断で確定）

| # | 軸 | 目標 | 備考 |
|---|---|---|---|
| SLO-1 | 品質 | edge振り分け分の good率 ≥ **always-cloud − 5pt** | 品質最優先 |
| SLO-2 | レイテンシ | edge p95 ≤ **2,000ms** | → **thinking OFF 必須** |
| SLO-3 | コスト | edge stack コスト < always-cloud（省コストが主目的） | |
| SLO-4 | Offload率 | **出力指標**（固定目標なし）。SLO-1 を満たす範囲で最大化 | 品質ゲート優先 |

主目的 = **品質維持しつつ省コスト**。よって「edge が確実に good な質問だけ edge、不確実は cloud へ
escalate」する**品質意識ルーティング**。offload率は結果として決まる。

## thinking on/off 検証（SLO-1×SLO-2 の両立確認）

Workers AI Gemma 4 は `chat_template_kwargs.enable_thinking=false` で thinking 無効化可能。

### レイテンシ（単発実測）

| 設定 | latency | 算定質問の答案 |
|---|---|---|
| thinking ON | 5,926ms | 「27,028単位」正しい |
| thinking OFF | **918ms** ✅SLO-2達成 | 「43万7,100円」誤り（正≈270,480円） |

### 品質（最難77件・参照注入）

| 構成 | good率 | latency |
|---|---|---|
| Gemma4 thinkON + 参照 | 45.5% | ~9秒 ✗ |
| **Gemma4 thinkOFF + 参照** | **41.6%** | **~1秒** ✅ |
| gemma3:4b + 参照 | 27.3% | ~2秒 |

category別（thinkON / thinkOFF）: calc-benefit 46/33（最大の劣化）、procedure 41/53、
boundary 50/38、system-explain 43/43、service-compare 50/50。

### 結論

- **thinking OFF で SLO-2（≤2秒, 実測918ms）達成、品質低下は約4pt のみ**（45.5→41.6）。
- gemma3:4b(27.3%) を thinkOFF でも圧倒。**Gemma4 thinkOFF + RAG が edge 構成として成立**。
- thinkOFF の劣化は **calc-benefit（算定）に集中**（46→33）→ **算定は Tool route**で決定論的に補う設計が正当。

## 確定アーキ方向（Capability Routing）

- **General/RAG route** = Gemma4 thinkOFF + RAG（≈1秒・捏造ほぼゼロ）
- **Tool route** = 算定系（限度額計算等）を決定論計算（LLMに計算させない）
- **Cloud escalate** = thinkOFF+RAG でも good にならない難問
- 配備先 = Gemma 4 26B A4B（Workers AI）

## 残データギャップ（SLO 数値の最終確定に必要）

| | 測定 | 用途 |
|---|---|---|
| A | **always-cloud good率**（cloud 120件生成＋採点） | SLO-1 の基準（quality loss の分母） |
| B | **Gemma4 thinkOFF good率（edge想定41件＝易問）** | edge が実際に handle する側の品質 |

※ 本書の 41.6% は cloud想定（最難）での値。edge が実際に担うのは edge想定（易問）で、より高い見込み。
A/B 測定後に「edge-routed good率 vs cloud good率」で SLO-1 達成可否を判定する。

## 成果物

- `data/phaseA-gemma4-incontext-results.json`（thinkON 45.5%）
- `data/phaseA-gemma4-incontext-results-thinkoff.json`（thinkOFF 41.6%）
- スクリプト: `eval/phaseA-gemma4-incontext.py`（GEMMA4_THINKING=off で切替）

## 次

1. 測定 A（cloud baseline）+ B（Gemma4 thinkOFF on 易問）→ SLO-1 数値確定
2. RAG MVP（厚労省Q&A〜50件）構築 → 実RAG で oracle 41.6% にどこまで迫れるか（Kilo handoff 候補）
3. Tool route（限度額計算）設計（Kilo handoff 候補）
