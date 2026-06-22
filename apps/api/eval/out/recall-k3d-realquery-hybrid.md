# recall@k 計測 — hybrid(dense+bm25, RRF c=10)

- 日時: 2026-06-22T12:53:39.477Z
- elapsed: 19s
- gold: 26件 / K_MAX=8 / mode=hybrid(dense+bm25, RRF c=10)
- RRF: w(dense)=5 w(bm25)=1 c=10

## recall@k（全件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 17 | 26 | 65.4% |
| 3 | 21 | 26 | 80.8% |
| 5 | 22 | 26 | 84.6% |
| 8 | 22 | 26 | 84.6% |

## recall@k（固定比較セット: out/40 missing 13件）

| k | hit | n | recall |
|---|---|---|---|
| 1 | 1 | 2 | 50.0% |
| 3 | 1 | 2 | 50.0% |
| 5 | 1 | 2 | 50.0% |
| 8 | 1 | 2 | 50.0% |

### missing 2件 詳細

| id | category | found at | top1 score | top-5 ids |
|---|---|---|---|---|
| gold-A-038 | procedure | top-1 | 0.455 | gold-A-038, gold-A-037, gold-A-050, mhlw-qa-0694, gold-A-060 |
| gold-A-105 | boundary-case | not in top-8 | 0.455 | mhlw-qa-0742, mhlw-qa-0804, gold-A-082, mhlw-qa-0212, mhlw-qa-1279 |
