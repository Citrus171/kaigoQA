# A1 §3a: BM25 最小スパイク — A-105/114 rank 確認

- 日時: 2026-06-22T05:26:57.420Z
- elapsed: 2s
- corpus: 135 docs / vocab 1112 / avgdl 51.9
- BM25 params: k1=1.5 b=0.75

## gold-A-105 (boundary-case)

**query**: 介護保険と医療保険の負担区分の線引きが難しいケースについて具体例で教えて

**BM25 rank**: 1

| rank | srcId | score |
|---|---|---|
| 1 | gold-A-105 | 14.1593 ← self |
| 2 | gold-A-082 | 9.1746 |
| 3 | gold-calc-009 | 8.3328 |
| 4 | gold-A-044 | 8.0613 |
| 5 | gold-A-077 | 7.0879 |
| 6 | gold-A-103 | 6.6056 |
| 7 | gold-A-012 | 6.3653 |
| 8 | gold-A-002 | 6.2934 |
| 9 | gold-calc-017 | 5.9637 |
| 10 | gold-A-021 | 5.7265 |

- self score: 14.1593 → @1 score: 14.1593
- @1との差: 0.0000

## gold-A-114 (boundary-case)

**query**: 老老介護で共倒れになりそうです。どんな支援が受けられますか

**BM25 rank**: 57

| rank | srcId | score |
|---|---|---|
| 1 | gold-A-004 | 6.2368 |
| 2 | gold-A-108 | 5.4613 |
| 3 | gold-A-034 | 5.3179 |
| 4 | gold-A-053 | 5.2913 |
| 5 | gold-calc-020 | 5.1957 |
| 6 | gold-A-039 | 5.0207 |
| 7 | gold-A-040 | 4.9947 |
| 8 | gold-A-102 | 4.5479 |
| 9 | gold-A-030 | 4.2772 |
| 10 | gold-A-014 | 3.9866 |

- self score: 0.3621 → @1 score: 6.2368
- @1との差: 5.8746

## 判定

- A-105 BM25 rank: **1** → @3以内: YES
- A-114 BM25 rank: **57** → @3以内: NO

→ A-105 は BM25 で有効。§3b full hybrid に進む。
→ A-114 は予想通り BM25 不能。§4 query 拡張等を A1 後で検討。