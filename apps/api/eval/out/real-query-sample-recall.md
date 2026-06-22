# recall@k 計測 — hybrid(dense+bm25, RRF c=10)

- 日時: 2026-06-22T09:49:19.549Z
- elapsed: 6s
- gold: 26件 / K_MAX=8 / mode=hybrid(dense+bm25, RRF c=10)
- RRF: w(dense)=5 w(bm25)=1 c=10

## recall@k（全件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 17 | 26 | 65.4% |
| 3 | 21 | 26 | 80.8% |
| 5 | 25 | 26 | 96.2% |
| 8 | 26 | 26 | 100.0% |

## recall@k（固定比較セット: out/40 missing 13件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 1 | 2 | 50.0% |
| 3 | 1 | 2 | 50.0% |
| 5 | 2 | 2 | 100.0% |
| 8 | 2 | 2 | 100.0% |

### missing 2件 詳細

| id | category | found at | top1 score | top-5 ids |
|---|---|---|---|---|
| gold-A-038 | procedure | top-1 | 0.502 | gold-A-038, gold-A-037, gold-A-050, gold-A-065, gold-A-060 |
| gold-A-105 | boundary-case | top-4 | 0.531 | gold-A-082, gold-A-089, gold-calc-017, gold-A-105, gold-calc-009 |
