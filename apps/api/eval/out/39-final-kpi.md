# 39: 全 gold-a 135件 統合評価 → 最終 KPI

`2026-06-19 17:36` / elapsed=978s

## 背景

- out/38: gold tier 再精査を恒久化（005/014 単位数降格）
- Phase 2: 修正 gold + refined tier + V2 prompt で全135件の統合 KPI を確定
- 本レポート: 運用判断のための経営指標

## 構成

- corpus: q-level 135 chunks (全ref連結)
- embed: `@cf/baai/bge-m3` (Workers AI) — cache hit
- search: top-1 q-level chunk
- cloud gen: deepseek-v4-flash (OpenCode), prompt V2
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸 refined tier)
- tier: _manual_supp={'gold-calc-005': [4, 5], 'gold-calc-014': [3, 5]}

## 最終 KPI

| 指標 | 値 |
|---|---|
| **relaxed good（正規KPI）** | **119/135 = 88.1%** |
| strict good（副軸） | 93/135 = 68.9% |
| top-1 gid hit率 | 120/135 = 88.9% |
| factual誤り | 2/135 = 1.5% |
| overreach | 0/135 |

### bad 3分類

| 分類 | 件数 | 割合 |
|---|---|---|
| missing (検索不hit) | 13 | 9.6% |
| misinterpreted (factual誤り) | 0 | 0.0% |
| omitted (hit & factual・回答不十分) | 3 | 2.2% |
| **relaxed bad合計** | **16** | **11.9%** |

## カテゴリ別 KPI

| category | 件数 | relaxed good | strict good | top-1 hit |
|---|---|---|---|---|
| boundary-case | 20 | 16/20 (80%) | 16/20 (80%) | 16/20 (80%) |
| calc-benefit | 37 | 32/37 (86%) | 27/37 (73%) | 34/37 (92%) |
| procedure | 24 | 19/24 (79%) | 15/24 (62%) | 19/24 (79%) |
| service-compare | 18 | 18/18 (100%) | 10/18 (56%) | 18/18 (100%) |
| system-explain | 36 | 34/36 (94%) | 25/36 (69%) | 33/36 (92%) |

## expected別 KPI

| expected | 件数 | relaxed good | strict good | top-1 hit |
|---|---|---|---|---|
| cloud | 94 | 80/94 (85%) | 73/94 (78%) | 81/94 (86%) |
| edge | 41 | 39/41 (95%) | 20/41 (49%) | 39/41 (95%) |

## relaxed bad 一覧

| id | category | expected | top1 hit | 3分類 | reason |
|---|---|---|---|---|---|
| gold-A-020 | system-explain | cloud | N | missing | 主要事実の超過分自己負担が欠落 |
| gold-A-021 | system-explain | cloud | N | missing | 主要事実の一部が欠落 |
| gold-A-038 | procedure | edge | N | missing | 主要事実の欠落 |
| gold-A-042 | procedure | edge | N | missing | 介護保険脱退不可を説明していない |
| gold-A-046 | procedure | cloud | N | missing | 主要事実の多くが欠落 |
| gold-A-055 | procedure | cloud | N | missing | 主要事実の多くが欠落 |
| gold-A-056 | procedure | cloud | N | missing | 新規申請時の保険給付対象外を未記載 |
| gold-A-061 | calc-benefit | cloud | Y | omitted | 具体的数値欠落 |
| gold-A-070 | calc-benefit | cloud | Y | omitted | 支給限度額の具体的数値欠落 |
| gold-A-071 | calc-benefit | cloud | N | missing | 回答拒否で主要事実を欠落 |
| gold-A-105 | boundary-case | cloud | N | missing | 主要事実をカバーしていない |
| gold-A-112 | boundary-case | cloud | N | missing | 主要事実の一部が欠落 |
| gold-A-114 | boundary-case | cloud | N | missing | 主要事実の具体例が不足 |
| gold-A-118 | boundary-case | cloud | N | missing | 主要事実の一部が欠落 |
| gold-calc-004 | calc-benefit | cloud | Y | omitted | 主要事実の算定要件が不足 |
| gold-calc-013 | calc-benefit | cloud | N | missing | 主要事実の算定要件誤り |

## 考察

- **最終 relaxed KPI = 88.1%**。一次対応アシスタントとしての実用性: 高
- retrieval は top-1 hit 88.9% で安定的に機能
- factual 誤り率 1.5%: 許容範囲内
- overreach = 0: 安全側
- 最大の残課題: omitted 3件 = 2.2%。retrieval改善が先