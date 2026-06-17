# 12 granite3.2:8b 評価結果

決定日: 2026-06-17
GPU: RunPod Secure Cloud / RTX PRO 4500 Blackwell 32GB
独立judge: GPT-4o（OpenRouter）

## 結果

| 指標 | granite3.2:8b | gemma3:4b（CPU） | 差 |
|---|---|---|---|
| always-edge good率 | **20.6%** (7/34) | **29.4%** (10/34) | −8.8pt ❌ |
| always-cloud good率 | 46.4% (13/28) | 34.8% (8/23) | +11.6pt |
| quality loss | **3.6pt** | 0.0pt | +3.6pt |
| 現行offload率 | 14.7% (5/34) | 14.7% | — |
| edge p50 latency | 708ms | 33367ms | −97.9% ✅ |
| edge p95 latency | 2258ms | 69418ms | −96.7% ✅ |

## 判定

**granite3.2:8b は gemma3:4b に edge 品質で劣る（20.6% < 29.4%、−8.8pt）。** 

latency は GPU により大幅改善（708ms vs 33s）だが、品質面では 8B の恩恵がない。quality loss 3.6pt は Stage2 基準（<5pt）を満たすが、gemma3:4b の 0.0pt より悪化。

## 分析：なぜ 8B が 4B に負けるのか

1. **ドメインアライメント差**: gemma3 は 140 言語に日本語を含む多言語モデル。granite3.2 は 12 言語に日本語を含むが、日本語実品質は gemma3 に劣ると推定
2. **モデルサイズ ≠ 日本語品質**: granite3.2:8b (4.9GB) でも日本語 care domain では gemma3:4b (3.3GB) に及ばない
3. **Phase 0 の再解釈**: 推論能力限界仮説はモデル非依存の 4B vs 8B 比較ではなかった。gemma3:4b の日本語能力 > granite3.2:8b の日本語能力

## 4 モデル比較（確定）

| edge モデル | always-edge good率 | quality loss | latency p50 | 判定 |
|---|---|---|---|---|
| llama3.2:1b | 未評価（旧デフォルト） | — | — | ⬜ |
| granite3.2:2b | 6.1% | 13.0pt | CPU 50s | ❌ 却下 |
| **gemma3:4b** | **29.4%** | **0.0pt** | CPU 33s | ✅ 現最適 |
| granite3.2:8b | 20.6% | 3.6pt | **GPU 708ms** | ⚠ 品質劣 |

## 結論

1. **gemma3:4b が edge 品質の現状最適を維持**。29.4% は低いが、他モデルより高い
2. **8B クラスへの移行は現状では品質低下**。granite3.2:8b より gemma3:4b の方が日本語 care domain に適合
3. **gemma3:4b を GPU で動かせば latency 改善**（708ms級）。quality も損なわず offload率向上につながる
4. **次の候補は gemma3:12b**（Ollama 対応、多言語実績あり）。granite 系は日本語で gemma に勝てない
5. **RAG + gemma3:4b on GPU** が現実的な品質改善・latency改善の両立経路

## 推奨次の一手

| # | アクション | 理由 |
|---|---|---|
| 1 | gemma3:4b on GPU で eval:e2e 再評価 | latency 比較・品質変動確認 |
| 2 | gemma3:12b プルして eval:e2e | 8B granite の失敗を踏まえ、同一モデル系のスケールアップを試す |
| 3 | RAG（介護保険ナレッジベース注入）× gemma3:4b | 知識注入後に quality の限界を再測定 |
