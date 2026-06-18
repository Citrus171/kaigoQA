# 06 HANDOFF: ルーティング動作点（閾値）再探索

担当: **DeepSeek V4 Pro 単独**（純データ分析・再実行不要）／検算: Claude（スクリプト）／承認: 人間
作成: 2026-06-17

## 背景・目的

Stage2 判定は確定済み（latency p50 −55% / quality loss **0.0pt** / offload率 **14.7%**, judge=独立GPT-4o）。
問題は **offload率 14.7% が低すぎ**、cloud コスト削減効果が薄いこと。quality loss に余裕（基準 <5pt に対し実績 0.0pt）があるため、
**閾値を緩めて offload率を引き上げる動作点**を探す。loss<5pt を保ったまま offload率を最大化する閾値 `t` を提案せよ。

## 仕組み（確定事項）

- ルーターは各 query に連続スコア `score` を付け、`score < threshold → edge`、`else → cloud`。
- 本番閾値は環境変数 `AI_ROUTER_THRESHOLD`（`src/lib/routing.ts:25`）で上書き可能。提案 `t` はそのまま `AI_ROUTER_THRESHOLD=t` で適用できる。
- 現行 `threshold = -0.0297`。
- **再実行は不要**。下表は rejudge JSONL（`eval/data/rejudge-judge-openai-gpt-4o-e2e-ollama-gemma3-4b.jsonl`）から抽出済みで、各 item は edge/cloud 両方の独立judge採点を持つ。閾値を動かすだけで全動作点をオフラインで再計算できる。

## 定義（厳守）

- **good** = `factual && sufficient && !overreach`（`eval/judge.ts:30` と一致）。
- **judgeable** = `!skipped && !genFailed && answer.trim()!=""`（採点可能な本文がある）。
- **固定母集団 = always-cloud で judgeable な 23 件**（下表 `cJ=1`）。loss はこの 23 件で測る（分母を固定しないと offload を増やしたとき分母が動いて不公平になる）。
  - `always-cloud good率` = 23件の cloud good = **8/23 = 34.8%**（baseline・固定）。
  - `routed good率(t)` = 同23件について、`score<t` の item は **edge側good(eG)**、それ以外は cloud側good(cG) を採用して算出。
  - **loss(t) = 34.8% − routed good率(t)**。
- **offload率(t)** = `score<t` の件数 ÷ **全34件**（運用上の実オフロード割合。母集団23ではなく全件が分母）。

> 注意: 母集団23の外（`cJ=0` の11件＝cloud生成失敗等）は loss 計算には入れないが、offload率の分母には入る。これらを edge に振ると「cloudでは答えられなかったものをedgeが答える」挙動になる点は結論で言及すること。

## 入力データ（score 昇順・自己完結）

`eJ`=edge judgeable, `eG`=edge good, `cJ`=cloud judgeable, `cG`=cloud good（すべて独立judge=GPT-4o採点）。

| score | id | expected | eJ | eG | cJ | cG |
|---:|---|---|:-:|:-:|:-:|:-:|
| -0.1221 | gold-02 | edge | 1 | 0 | 1 | 0 |
| -0.1181 | gold-14 | edge | 1 | 1 | 1 | 1 |
| -0.1108 | gold-01 | edge | 1 | 0 | 1 | 0 |
| -0.0660 | gold-13 | edge | 1 | 1 | 1 | 1 |
| -0.0633 | gold-03 | edge | 1 | 1 | 1 | 1 |
| -0.0222 | gold-17 | edge | 1 | 0 | 0 | 0 |
| +0.0015 | gold-18 | cloud | 1 | 0 | 1 | 0 |
| +0.0049 | gold-22 | cloud | 1 | 0 | 1 | 1 |
| +0.0069 | gold-15 | edge | 1 | 0 | 0 | 0 |
| +0.0114 | gold-27 | cloud | 1 | 0 | 1 | 0 |
| +0.0174 | gold-04 | cloud | 1 | 1 | 1 | 1 |
| +0.0240 | gold-07 | cloud | 1 | 0 | 1 | 0 |
| +0.0249 | gold-11 | cloud | 1 | 1 | 1 | 0 |
| +0.0281 | gold-16 | edge | 1 | 0 | 0 | 0 |
| +0.0296 | gold-32 | cloud | 1 | 0 | 0 | 0 |
| +0.0402 | gold-05 | cloud | 1 | 0 | 1 | 0 |
| +0.0433 | gold-12 | cloud | 1 | 0 | 1 | 0 |
| +0.0439 | gold-10 | cloud | 1 | 1 | 1 | 0 |
| +0.0488 | gold-09 | cloud | 1 | 1 | 1 | 0 |
| +0.0533 | gold-24 | cloud | 1 | 0 | 0 | 0 |
| +0.0589 | gold-23 | cloud | 1 | 1 | 1 | 1 |
| +0.0627 | gold-06 | cloud | 1 | 1 | 1 | 0 |
| +0.0629 | gold-08 | cloud | 1 | 1 | 1 | 0 |
| +0.0707 | gold-20 | cloud | 1 | 0 | 1 | 0 |
| +0.0753 | gold-31 | cloud | 1 | 0 | 0 | 0 |
| +0.0812 | gold-33 | cloud | 1 | 0 | 1 | 0 |
| +0.0908 | gold-28 | cloud | 1 | 0 | 0 | 0 |
| +0.0910 | gold-19 | cloud | 1 | 0 | 0 | 0 |
| +0.0921 | gold-21 | cloud | 1 | 0 | 1 | 0 |
| +0.0942 | gold-25 | cloud | 1 | 0 | 0 | 0 |
| +0.0970 | gold-29 | cloud | 1 | 0 | 1 | 1 |
| +0.1063 | gold-34 | cloud | 1 | 0 | 0 | 0 |
| +0.1103 | gold-30 | cloud | 1 | 0 | 0 | 0 |
| +0.1337 | gold-26 | cloud | 1 | 0 | 1 | 1 |

## タスク手順

1. 閾値 `t` を各 score の境界でスイープ（隣接 score の中点でよい）。
2. 各 `t` について `offload率(t)` と `routed good率(t)` と `loss(t)` を上記定義で算出し、テーブル化。
3. `loss(t) < 5pt` を満たす **最大 offload率** の `t` を推奨動作点として提示。対応する `AI_ROUTER_THRESHOLD` 値も明記。
4. 推奨点で「どの item が edge に新規offloadされ、そのうち good を失うのはどれか」を列挙（gold-id 単位）。
5. 構造的限界を結論で述べる: edge good（eG）が `score<-0.06` の3件（gold-14/13/03）以外ほぼ 0 のため、offload を増やすと cloud-good item の edge化で loss が急増しやすい。loss<5pt の余地が実質どこまでかを明言する。

## 成果物形式

- `out/07-operating-point.md`: スイープ表 + 推奨 `t`/`AI_ROUTER_THRESHOLD` + offload率/loss + offload対象id + 限界の考察。
- 数値はすべて上表から再現可能であること（出典 = 本HANDOFFの表）。

## 検算アンカー（Claude確認済み・この値に一致しないなら計算ミス）

- 現行 `t=-0.0297`: offload率 **5/34=14.7%**, routed good率 **8/23=34.8%**, loss **0.0pt**。
- baseline always-cloud good率 = **8/23=34.8%**（固定母集団の good item は gold-14,13,03,22,04,23,29,26 の8件）。
- `t` を上げて最初に loss が出るのは **gold-22(score=+0.0049)** を edge化したとき（cG=1→eG=0, loss 1件=4.3pt）。
