# 08 edge モデル比較（gemma3:4b vs granite3.2:2b）

決定日: 2026-06-17
judge: 独立 GPT-4o（OpenRouter 経由）
cloud: deepseek-v4-pro（共通・gemma3 E2E の cloud 回答を流用）
基準: Stage2（ADR 0001）quality loss < 5pt

## 比較表

| 指標 | gemma3:4b | granite3.2:2b |
|---|---|---|
| always-edge good率 | 10/34 = **29.4%** | 2/33 = **6.1%** |
| always-cloud good率 | 8/23 = 34.8% | 9/23 = 39.1% |
| routed good率 | 8/23 = 34.8% | 6/23 = 26.1% |
| quality loss | **0.0pt** ✅ | **13.0pt** ❌ |
| offload率 | 14.7% (5/34) | 14.7%（同一ルーター） |
| p50 latency | 33367ms | 67266ms |

## 判定

**granite3.2:2b は Stage2 基準を満たさない。** gemma3:4b が現状の最適 edge モデル。

理由:
- 日本語介護ドメインでの good率が gemma3:4b (29.4%) に対し granite3.2:2b は 6.1% と壊滅的
- quality loss 13.0pt は閾値 5pt の 2.6 倍
- latency も gemma3:4b の約 2 倍遅い（CPU環境・いずれも実用には GPU 必須）

## 所見

1. **日本語品質はパラメータ数以上にモデル選定が重要**: gemma3:4b (3.3GB) > granite3.2:2b (1.5GB) だが、単純なサイズ差では説明できない性能差（29.4% vs 6.1%）
2. **granite3.2:2b の 2B サイズでは日本語介護ドメインに非対応**: Apache 2.0 ライセンスの利点はあるが、品質が足りない
3. **次の候補**: granite3.2:8b (4.9GB) なら改善の可能性があるが、CPU 環境では実用的でない
4. **gemma3:4b が現状維持のベースライン**: offload率改善には gemma3:4b の品質向上（fine-tuning / RAG 統合）が必要

## 推奨

| 優先度 | アクション |
|---|---|
| 1 | gemma3:4b で offload率 20.6% へ閾値調整（07-operating-point.md 参照） |
| 2 | GPU 環境で granite3.2:8b を評価（8B なら日本語品質が改善している可能性） |
| 3 | gemma3:4b の fine-tuning または RAG 統合で edge 品質を 29.4%→40%+ へ引き上げ |
| 4 | granite3.2:2b は却下。2B クラスでは llama3.2:1b（29.4%同等か）も再評価候補だが gemma3:4b 以下と予想 |
