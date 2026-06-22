# A0 (b)(c) 結果メモ — Kilo → Claude/ユーザー

- 日付: 2026-06-22
- 担当: Kilo（A0(b)(c) 実装）
- 親: docs/rag-retrieval-improvement-plan-2026-06-22.md §A0 / handoff: kilo/2026-06-22-02-handoff-a0-recall-harness-and-tokenize-spike.md

## 成果物

| 成果物 | パス | 実行 |
|---|---|---|
| (b) recall@k 足場 | `apps/api/eval/recall-at-k.ts` | `npm run eval:recall -w @hybrid/api` |
| (b) 結果 | `apps/api/eval/out/recall-at-k.md` | — |
| (c) kuromoji スパイク | `apps/api/eval/spike-tokenize.ts` | `npm run eval:tokenize -w @hybrid/api` |
| (c) 生データ | `apps/api/eval/out/spike-tokenize.md` | — |
| (c) 結論・推奨 | `apps/api/eval/out/spike-tokenize-conclusion.md` | — |

依存追加: `kuromojin@3`（api の devDependency）。
npm script 追加: `eval:recall` / `eval:tokenize`。

## (b) recall@k 結果

全件（135件・self-match・pgvector rag_chunks・CF bge-m3）:

| k | hit | n | recall |
|---|---|---|---|
| 1 | 120 | 135 | 88.9% |
| 3 | 131 | 135 | 97.0% |
| 5 | 131 | 135 | 97.0% |
| 8 | 132 | 135 | 97.8% |

missing 13件（out/40 整合確認用）:

| k | hit | n | recall |
|---|---|---|---|
| 1 | 0 | 13 | 0.0% |
| 3 | 10 | 13 | 76.9% |
| 5 | 10 | 13 | 76.9% |
| 8 | 11 | 13 | 84.6% |

- out/40 の missing 13件 top-3 recovery ~77% と **@3=76.9% で整合確認OK**。
- **top-8 でも回収できず**: gold-A-071 / gold-A-114（embedding/chunk 設計が主因の可能性）。
- gold-A-105 は top-8 で回収（top-3/5 では外）。

## (c) kuromoji 結論

**A1 BM25 トークナイザ = kuromoji（kuromojin）採用 GO**。

- 数値・条文・固有名詞が意味単位で分割、bigram の無意味 n-gram を回避。
- 注意点: カンマ込み数値「19,705」→ 19/`,`/705 に分断。A1 で前処理（カンマ除去）必須。
- 詳細は `spike-tokenize-conclusion.md`。

## A1 へのインプット

1. **BM25 トークナイザ確定**: kuromojin（`tokenize(text)` → `surface_form`）。
2. **前処理**: カンマ除去 + 記号除去（★/×/〜/括弧）を stopword 的に処理。
3. **計測足場**: `npm run eval:recall` で A1 hybrid の before/after を再現可能。アルゴリズム変更後も同スクリプトで recall@1/3/5/8 を比較。
4. **残律速**: top-8 外 2件（gold-A-071/114）は hybrid でも回収困難の可能性。embedding/chunk 設計の併用検討が A1 以降の候補。

## (a) との非干渉

- (b)(c) とも gold ラベル・`routing-gold-a.jsonl` の判断領域には踏み込んでいない。
- missing 13件 ID は handoff 指定の参照用（out/40 整合確認）のみに使用。
