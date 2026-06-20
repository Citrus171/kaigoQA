# 40: retrieval missing 13件 回収可能性分析

`2026-06-19 17:39` / elapsed=4s

## 背景

- out/39: 全135件 relaxed 88.1%。missing 13件(9.6%)が最大律速
- Sprint 1: top-3/top-5 で何件回収できるか定量評価 → 検索戦略か embedding 設計か

## 結果

| k | 回収件数 | 回収率 | cumulative |
|---|---|---|---|
| 1 | 0 | 0% | 0/13 |
| 2 | 7 | 54% | 7/13 |
| 3 | 10 | 77% | 10/13 |
| 4 | 10 | 77% | 10/13 |
| 5 | 10 | 77% | 10/13 |

### 件別詳細

| id | category | n_refs | found at | top5 ids |
|---|---|---|---|---|
| gold-A-020 | system-explain | 5 | top-2 | gold-A-076, gold-A-020, gold-A-078 |
| gold-A-021 | system-explain | 4 | top-3 | gold-A-004, gold-calc-010, gold-A-021 |
| gold-A-038 | procedure | 5 | top-3 | gold-A-050, gold-A-065, gold-A-038 |
| gold-A-042 | procedure | 5 | top-2 | gold-A-107, gold-A-042, gold-A-054 |
| gold-A-046 | procedure | 5 | top-2 | gold-A-058, gold-A-046, gold-A-050 |
| gold-A-055 | procedure | 5 | top-2 | gold-A-044, gold-A-055, gold-A-112 |
| gold-A-056 | procedure | 4 | top-2 | gold-A-048, gold-A-056, gold-A-037 |
| gold-A-071 | calc-benefit | 6 | not in top-5 | gold-calc-014, gold-calc-001, gold-calc-012 |
| gold-A-105 | boundary-case | 4 | not in top-5 | gold-A-082, gold-A-004, gold-A-019 |
| gold-A-112 | boundary-case | 5 | top-3 | gold-A-051, gold-A-069, gold-A-112 |
| gold-A-114 | boundary-case | 6 | not in top-5 | gold-A-033, gold-A-120, gold-A-119 |
| gold-A-118 | boundary-case | 5 | top-2 | gold-A-103, gold-A-118, gold-A-009 |
| gold-calc-013 | calc-benefit | 6 | top-2 | gold-A-084, gold-calc-013, gold-A-029 |

## 考察

- top-3 回収: **10/13件**。top-3 に拡大する価値: 高 (+10件改善)
- top-5 回収: **10/13件**
- not in top-5: **3/13件**。一部がembedding問題
- **推奨**: top-3 を採用すれば relaxed 88.1% → 推定 95.5% (top-1 の回答品質低下リスクは要確認)

- missing 13件のカテゴリ分布: procedure 7件, boundary-case 4件, calc-benefit 2件。procedure 領域が retrieval に弱い