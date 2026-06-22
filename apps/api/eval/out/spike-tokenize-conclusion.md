# A0(c): kuromoji トークナイズ・スパイク 所見・推奨

- 日付: 2026-06-22
- 担当: Kilo（A0(c)）
- 親: docs/rag-retrieval-improvement-plan-2026-06-22.md §A0
- 成果物: `apps/api/eval/spike-tokenize.ts`（`npm run eval:tokenize`）
- 生データ: `apps/api/eval/out/spike-tokenize.md`
- tokenizer: kuromojin（kuromoji@0.1.2 + ipadic）

## 結論: A1 BM25 トークナイザ = kuromoji 採用 **GO**

kuromoji は数値・条文・固有名詞を意味ある語彙単位に分割し、素朴 bigram「介護保険→介護/護保/保険」の無意味 n-gram を回避する。BM25 の語彙一致に使える形で残るため、A1 Hybrid(BM25) のトークナイザとして採用可。

## 根拠（代表語）

| 入力 | トークン | 評価 |
|---|---|---|
| 介護保険 | 介護/保険 | 制度語が意味単位。bigram の「護保」なし |
| 区分支給限度基準額 | 区分/支給/限度/基準/額 | 制度語を正確に分割 |
| 要介護2 | 要/介護/2 | 数値「2」が独立 token |
| 地域区分 | 地域/区分 | 意味単位 |
| 1割負担 | 1/割/負担 | 「1割」が意味単位 |
| 介護保険法第8条 | 介護/保険/法/第/8/条 | 「8」が独立 token で条文の語彙一致可 |
| 特定疾病16疾病 | 特定/疾病/16/疾病 | 数値「16」が独立 |

missing 13件の query/referencePoints サンプル（gold-A-020/021/038/042）でも、制度語・数値・年齢（40〜64歳）が意味単位で分割され、BM25 index/query 双方で語彙一致が機能する形。

## 注意点（A1 実装時の前処理必須）

- **カンマ込み数値の分断**: 「19,705単位」→ 19/`,`/705/単位 に分かれる。カンマが独立 token 化し、数値が 19 と 705 に割れる。
  - 対策: tokenize 前にカンマ除去（または数字列の連結正規化）を前処理に入れ、「19705単位」→ 19705/単位 に揃える。表記揺れ（19,705 / 19705）も吸収できる。
- **記号の token 化**: 「★」「×」「〜」「（」「）」等も token 化される。BM25 の stopword/記号除去で対応可（referencePoints 先頭の「★」印は除去前提）。

## 次案（kuromoji 不可の場合の代替・今回は不要）

- pgroonga 内蔵トークナイザ（MeCab 系・PostgreSQL 拡張）。kuromoji で GO のため不採用。
- pg_bigm / pg_trgm は n-gram 系で本件趣旨（無意味 n-gram 回避）から外れるため不適。

## A1 へのインプット

- **BM25 トークナイザ**: kuromojin。`tokenize(text)` → `surface_form` を語彙とする。
- **前処理パイプライン**: カンマ除去 + 記号除去（★/×/〜/括弧等）を stopword 的に処理してから tokenize。
- **辞書**: ipadic は初回ネットワーク fetch ＆キャッシュ（~数MB）。A1 本実装でキャッシュ方針を設計時に決める（リポジトリ外キャッシュ or 初回起動 fetch）。
