# recall@k 計測 — hybrid(dense+bm25, RRF c=10)

- 日時: 2026-06-22T09:25:01.399Z
- elapsed: 24s
- gold: 135件 / K_MAX=8 / mode=hybrid(dense+bm25, RRF c=10)
- RRF: w(dense)=5 w(bm25)=1 c=10

## recall@k（全件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 120 | 135 | 88.9% |
| 3 | 132 | 135 | 97.8% |
| 5 | 133 | 135 | 98.5% |
| 8 | 134 | 135 | 99.3% |

## recall@k（固定比較セット: out/40 missing 13件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 2 | 13 | 15.4% |
| 3 | 11 | 13 | 84.6% |
| 5 | 12 | 13 | 92.3% |
| 8 | 12 | 13 | 92.3% |

### missing 13件 詳細

| id | category | found at | top1 score | top-5 ids |
|---|---|---|---|---|
| gold-A-020 | system-explain | top-2 | 0.545 | gold-A-076, gold-A-020, gold-A-078, gold-A-083, gold-calc-004 |
| gold-A-021 | system-explain | top-3 | 0.526 | gold-A-004, gold-calc-010, gold-A-021, gold-A-003, gold-A-042 |
| gold-A-038 | procedure | top-3 | 0.538 | gold-A-050, gold-A-065, gold-A-038, gold-A-037, gold-A-060 |
| gold-A-042 | procedure | top-1 | 0.508 | gold-A-042, gold-A-107, gold-A-054, gold-A-049, gold-A-082 |
| gold-A-046 | procedure | top-2 | 0.526 | gold-A-058, gold-A-046, gold-A-050, gold-A-065, gold-A-045 |
| gold-A-055 | procedure | top-2 | 0.545 | gold-A-044, gold-A-055, gold-A-043, gold-A-112, gold-A-058 |
| gold-A-056 | procedure | top-2 | 0.507 | gold-A-048, gold-A-056, gold-A-037, gold-A-039, gold-A-060 |
| gold-A-071 | calc-benefit | top-1 | 0.545 | gold-A-071, gold-calc-014, gold-calc-001, gold-calc-012, gold-calc-004 |
| gold-A-105 | boundary-case | top-5 | 0.538 | gold-A-082, gold-A-019, gold-A-004, gold-A-103, gold-A-105 |
| gold-A-112 | boundary-case | top-2 | 0.510 | gold-A-051, gold-A-112, gold-A-069, gold-A-075, gold-A-052 |
| gold-A-114 | boundary-case | not in top-8 | 0.455 | gold-A-033, gold-A-120, gold-A-004, gold-A-119, gold-A-047 |
| gold-A-118 | boundary-case | top-2 | 0.545 | gold-A-103, gold-A-118, gold-A-009, gold-A-097, gold-A-025 |
| gold-calc-013 | calc-benefit | top-2 | 0.496 | gold-A-084, gold-calc-013, gold-A-029, gold-A-077, gold-A-027 |
