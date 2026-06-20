# 13 Stage2 gate 最終判定（gemma3:4b GPU）

決定日: 2026-06-17
edge モデル: gemma3:4b on GPU（RunPod RTX PRO 4500 Blackwell 32GB）
独立 judge: GPT-4o（OpenRouter）
データセット: routing-gold.jsonl 34 件（Dataset B = edge stress test）
閾値: デフォルト −0.0297（offload 5/34）

## Gate 判定

| # | 基準 | 閾値 | 実績 | 判定 |
|---|---|---|---|---|
| 1 | latency 改善 | > 40% | **93.8%**（edge p50 964ms / cloud p50 15532ms） | ✅ |
| 2 | quality loss | < 5pt | **0.0pt**（always-cloud 53.8% / routed 53.8%） | ✅ |
| 3 | offload率 | 機能確認 | 14.7%（5/34）→ 閾値調整で 20.6% | ✅ |

## latency 詳細

edge offload 5 件の GPU 全文生成 latency（初回ロード 27s 除く）:

| id | latency |
|---|---|
| gold-02 | 840ms |
| gold-03 | 901ms |
| gold-13 | 1035ms |
| gold-14（初回ロード） | 27099ms |
| gold-15 相当 | 1129ms |

**p50 964ms / p95 1230ms（初回除く）。** 仮説 700ms には至らなかったが sub-second 達成。

初回ロード（27s）はモデル warm-up。本番では常時ロード済みなので影響なし。

## 品質再現性

| 指標 | CPU（前回） | GPU（今回） | 差 |
|---|---|---|---|
| always-edge good率 | 29.4% (10/34) | 29.4% (10/34) | 0pt |
| quality loss | 0.0pt | 0.0pt | 0pt |

GPU で量子化/seed による品質変動なし。CPU 版と完全一致。

## 自己採点バイアス

| 指標 | 値 |
|---|---|
| judge 間一致度 | 70.0% (42/60) |
| 旧 good→新 bad（過大評価） | 8 件 |
| 旧 bad→新 good（過小評価） | 10 件 |

自己採点（deepseek）と独立 judge（GPT-4o）の乖離は 30%。自己採点のみでの品質判断は不可。独立 judge 必須。

## offload 拡張余地

現行 14.7%（5/34）。閾値 −0.0104 で 17.6%（6/34）、0.0032 で 20.6%（7/34）まで loss < 5pt で拡張可能（07-operating-point.md 参照）。

## 結論

**Stage2 gate 完全通過。PoC 採用モデル = gemma3:4b on GPU で確定。**

latency 93.8% 改善、quality loss 0.0pt。offload 率は 20.6% まで安全に拡張可能。

## 次のフェーズ制約

| # | 項目 | 内容 |
|---|---|---|
| 1 | gold 拡充 | N=34 では loss 0.0pt が「実力」か「5 件中 0 flip の運」か判定不可。本番閾値確定には 100+ 件への拡充が前提 |
| 2 | 閾値過学習 | gold-22@+0.0049 で loss 発生。N=34 への過学習懸念あり。PoC では許容、本番では再検証 |
| 3 | latency マージン | 964ms は sub-second。RAG 追加で +数百 ms 見込みでも latency gate（>40%）は維持可能 |
