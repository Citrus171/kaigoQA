# recall@k 計測 — hybrid+rerank(dense+bm25 RRF c=10 → cf:@cf/baai/bge-reranker-base, candidates=20)

- 日時: 2026-06-22T09:23:38.453Z
- elapsed: 96s
- gold: 135件 / K_MAX=8 / mode=hybrid+rerank(dense+bm25 RRF c=10 → cf:@cf/baai/bge-reranker-base, candidates=20)
- RRF: w(dense)=5 w(bm25)=1 c=10

## recall@k（全件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 70 | 135 | 51.9% |
| 3 | 100 | 135 | 74.1% |
| 5 | 115 | 135 | 85.2% |
| 8 | 125 | 135 | 92.6% |

## recall@k（固定比較セット: out/40 missing 13件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 3 | 13 | 23.1% |
| 3 | 7 | 13 | 53.8% |
| 5 | 9 | 13 | 69.2% |
| 8 | 10 | 13 | 76.9% |

### missing 13件 詳細

| id | category | found at | top1 score | top-5 ids |
|---|---|---|---|---|
| gold-A-020 | system-explain | top-7 | 0.828 | gold-A-062, gold-A-074, gold-calc-007, gold-A-080, gold-A-076 |
| gold-A-021 | system-explain | not in top-8 | 0.999 | gold-A-075, gold-A-004, gold-A-107, gold-calc-019, gold-A-015 |
| gold-A-038 | procedure | top-1 | 0.868 | gold-A-038, gold-A-037, gold-A-050, gold-A-060, gold-A-065 |
| gold-A-042 | procedure | top-5 | 0.998 | gold-A-054, gold-A-068, gold-calc-019, gold-A-039, gold-A-042 |
| gold-A-046 | procedure | top-1 | 0.950 | gold-A-046, gold-A-107, gold-A-058, gold-A-038, gold-A-042 |
| gold-A-055 | procedure | top-1 | 0.991 | gold-A-055, gold-A-112, gold-A-051, gold-A-044, gold-A-118 |
| gold-A-056 | procedure | top-2 | 0.991 | gold-A-107, gold-A-056, gold-A-060, gold-A-059, gold-A-039 |
| gold-A-071 | calc-benefit | top-2 | 0.879 | gold-A-080, gold-A-071, gold-A-093, gold-A-077, gold-calc-016 |
| gold-A-105 | boundary-case | top-4 | 0.982 | gold-A-075, gold-A-009, gold-A-004, gold-A-105, gold-A-036 |
| gold-A-112 | boundary-case | top-2 | 0.991 | gold-A-107, gold-A-112, gold-A-111, gold-A-120, gold-A-054 |
| gold-A-114 | boundary-case | not in top-8 | 0.986 | gold-A-036, gold-A-107, gold-A-025, gold-A-119, gold-A-009 |
| gold-A-118 | boundary-case | top-2 | 0.999 | gold-A-103, gold-A-118, gold-A-009, gold-A-034, gold-A-075 |
| gold-calc-013 | calc-benefit | not in top-8 | 0.999 | gold-A-076, gold-A-080, gold-A-083, gold-A-020, gold-A-061 |
