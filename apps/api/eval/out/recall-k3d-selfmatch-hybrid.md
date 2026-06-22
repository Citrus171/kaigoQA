# recall@k 計測 — hybrid(dense+bm25, RRF c=10)

- 日時: 2026-06-22T12:53:00.126Z
- elapsed: 47s
- gold: 135件 / K_MAX=8 / mode=hybrid(dense+bm25, RRF c=10)
- RRF: w(dense)=5 w(bm25)=1 c=10

## recall@k（全件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 104 | 135 | 77.0% |
| 3 | 123 | 135 | 91.1% |
| 5 | 128 | 135 | 94.8% |
| 8 | 129 | 135 | 95.6% |

## recall@k（固定比較セット: out/40 missing 13件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 1 | 13 | 7.7% |
| 3 | 6 | 13 | 46.2% |
| 5 | 10 | 13 | 76.9% |
| 8 | 10 | 13 | 76.9% |

### missing 13件 詳細

| id | category | found at | top1 score | top-5 ids |
|---|---|---|---|---|
| gold-A-020 | system-explain | top-5 | 0.526 | gold-A-076, mhlw-qa-1505, mhlw-qa-0077, mhlw-qa-0078, gold-A-020 |
| gold-A-021 | system-explain | top-5 | 0.538 | gold-A-004, gold-calc-010, gold-A-003, gold-calc-020, gold-A-021 |
| gold-A-038 | procedure | top-3 | 0.531 | gold-A-050, gold-A-065, gold-A-038, mhlw-qa-0694, gold-A-037 |
| gold-A-042 | procedure | top-2 | 0.455 | gold-A-107, gold-A-042, mhlw-qa-0694, mhlw-qa-1730, gold-A-054 |
| gold-A-046 | procedure | top-1 | 0.488 | gold-A-046, gold-A-058, mhlw-qa-0469, mhlw-qa-0460, mhlw-qa-0468 |
| gold-A-055 | procedure | top-2 | 0.545 | gold-A-044, gold-A-055, mhlw-qa-0842, gold-A-043, mhlw-qa-0811 |
| gold-A-056 | procedure | top-3 | 0.531 | mhlw-qa-0240, mhlw-qa-0190, gold-A-056, gold-A-048, gold-A-039 |
| gold-A-071 | calc-benefit | not in top-8 | 0.545 | mhlw-qa-1062, mhlw-qa-0506, mhlw-qa-2222, mhlw-qa-0992, mhlw-qa-0505 |
| gold-A-105 | boundary-case | not in top-8 | 0.538 | gold-A-082, mhlw-qa-1279, mhlw-qa-0804, mhlw-qa-1202, gold-A-004 |
| gold-A-112 | boundary-case | top-4 | 0.455 | gold-A-051, gold-A-069, gold-A-075, gold-A-112, mhlw-qa-1627 |
| gold-A-114 | boundary-case | not in top-8 | 0.455 | gold-A-033, gold-A-120, gold-A-119, gold-A-004, gold-A-047 |
| gold-A-118 | boundary-case | top-2 | 0.545 | gold-A-103, gold-A-118, gold-A-009, gold-A-097, gold-calc-015 |
| gold-calc-013 | calc-benefit | top-4 | 0.526 | mhlw-qa-2513, gold-A-084, mhlw-qa-2560, gold-calc-013, mhlw-qa-2267 |
