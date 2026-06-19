# Confidence Predictor: Pre-generation 予測は不成立

**日時**: 2026-06-18
**関連**: [[24-selective-routing-ceiling]] [[23-slo1-cloud-baseline]]

## 背景

out/24 で selective routing の oracle 天井 70.7% / offload 36.6% が判明。
本書では、edge_good を**事前（生成前）**に判定する confidence 予測器の実現可能性を検証した。

## Phase 1: シグナル探索

edge想定41件（good=15, non-good=26）について7特徴量と edge_good の相関を分析。

| 特徴量 | 相関 (r) | 判定 |
|--------|----------|------|
| `ref_count` | -0.200 | 無相関・逆方向 |
| `ref_chars` | +0.200 | 弱・正方向 |
| `query_len` | +0.140 | 無相関 |
| `has_numeric` | -0.019 | 無相関 |
| `edge_cos_sim` | +0.079 | 無相関 |
| `centroid_margin` | +0.113 | 無相関 |
| `edge_answer_len` | **+0.419** | 中程度（post-hoc） |
| `cloud_answer_len` | +0.359 | 中程度（post-hoc） |

**所見**: 事前に利用可能な特徴量はいずれも |r| < 0.2。唯一中程度の相関を示す `edge_answer_len` は**事後**にしか得られない。
また non-good 26件はすべて `partial`（捏造ゼロ・十分性不足）で、問題は model capacity。

## Phase 2: 評価指標

| 指標 | 定義 | 目標 |
|------|------|------|
| Edge Precision | 予測good件中の実際good率 | ≥ 63.4% |
| Offload Rate | edge処理割合 | oracle 36.6% に近づく |
| Oracle Capture | `(selective − 63.4) / (70.7 − 63.4)` | ≥ 50% で価値あり |

### Baselines

| 戦略 | good | 率 | precision | offload | Oracle Capture |
|------|------|-----|-----------|---------|----------------|
| all-cloud+RAG | 26/41 | 63.4% | — | 0% | 0%（参照線） |
| all-edge | 15/41 | 36.6% | 36.6% | 100% | −366.7% |
| oracle | 29/41 | 70.7% | 100% | 36.6% | 100%（上限） |
| null（random offload 37%） | — | ~53.6% | — | — | — |

## Phase 3 Step 1: 手作業ルール全探索

34単独ルール + 2条件組合せ（top10） + 3条件組合せ（top5）を網羅試行。

**結果: 全ルールで Oracle Capture ≤ 0%。all-cloud+RAG を上回るルールは存在しない。**

| ルール | offload | selective rate | Oracle Capture |
|--------|---------|----------------|----------------|
| `ref_count >= 7`（最良） | 0% | 63.4% | 0%（=cloudと同値） |
| `margin >= 0.15` | 14.6% | 63.4% | 0%（品質改善なし） |
| `ref_count >= 6` | 9.8% | 61.0% | −33%（cloud より劣化） |
| `category==system-explain` | 48.8% | 56.1% | −100%（大幅劣化） |
| （その他全ルール） | — | ≤ 63.4% | ≤ 0% |

## 結論

**Pre-generation confidence prediction は現在の特徴量では不成立。**
手作業ルールも logistic regression も、これらの特徴量では cloud baseline 63.4% を超えられない。

### 根因

1. 利用可能な事前特徴量（ref_count, margin, query_len, category）の edge_good 識別力が決定的に不足
2. 唯一中程度の相関を持つ `answer_length` は事後シグナル（生成前に使えない）
3. 失敗26件はすべて `partial`（model capacity の天井）であり、routing 判断とは独立した要因

### 実用的な意味

selective routing の設計は、**事前予測**ではなく**事後判断**（post-hoc quality check）か、**より強い edge モデル**の導入に方針転換する必要がある。

## 次方向の候補

1. **post-hoc 自己整合性チェック**: edge生成 → 品質評価 → 不十分なら cloud 再送（answer_length 等の事後シグナル活用可）
2. **Gemma4 thinking有効版**: 現状 thinkOFF だが、thinking 有効で model capacity 向上する可能性
3. **all-cloud+RAG 63.4% を実用水準と割り切る**: edge 全振り不可だが、cloud+RAG は当初の always-cloud 7.5% から大幅改善
