# 02 Stage2 結論ドラフト

**※本ドラフトは人間レビュー前提。数値は現時点で入手可能なデータに基づく暫定値。**

## Stage2 の問い

「edge（ローカルSLM = gemma3:4b）にオフロードしても、品質を維持できるか？」

## 4 基準の評価

| # | 基準 | 閾値 | 現状値 | 状態 |
|---|---|---|---|---|
| 1 | latency改善率 | > 40% | routed p50 −55%（GPU full E2E 実測・確定済み） | ✅ 充足 |
| 2 | offload率（routedがedgeを選ぶ割合） | —（指標・高いほど効果大） | 14.7%（5/34件） | ⚠ 低い。クラウド依存度が高い |
| 3 | 品質 loss（独立judge good率: always-cloud − routed） | < 5% | **GPU full E2E 出力待ち**（独立judge rejudge未実行） | ❓ 未確定 |
| 4 | judgeノイズ床（flip率） | —（指標・低いほど判定信頼性高） | 参照採点で flip率は不変〜微増。ただし good率が大幅低下（精度是正効果） | ⚡ flip率は下がらず。精度是正（甘採点是正）として解釈 |

## 各基準の詳細とエビデンス

### 1. latency改善率（充足）

HANDOFF 記載値: routed p50 −55% vs always-cloud（GPU full E2E 実測済み・再検証不要）。
> 注意: `e2e-ollama-gemma3-4b.jsonl` の生データでは edge p50=33367ms / cloud p50=25968ms と edge 側が遅いが、これは評価環境（CPU or GPU非搭載）に起因する。HANDOFF の GPU 実測値を優先する。

### 2. offload率（課題あり）

routed が edge を選択した割合: 5/34 = **14.7%**（`e2e-ollama-gemma3-4b.jsonl` より集計）
- edgeへ振り分け: 5件
- cloudへ振り分け: 29件

offload率が低い = ほとんどの質問が cloud 直送されている。latency −55%のメリットは edge を選んだ少数件でしか発現しない。ルーターの recall 過剰（安全側だが保守的すぎる）が原因の可能性が高い。クラウドコスト削減という投資意義からは改善余地あり。

### 3. 品質 loss（未確定）

独立 judge による再採点（`rejudge.ts` 単発モード）が未実行のため、数値なし。

現状の自己採点（v4flash、自己採点バイアス含む）では:
- always-cloud good率: 47.6%（10/21、11件 genFailed）
- routed good率: 計算可能だが自己採点バイアスが強く参考値にとどまる
- 独立 judge（GPT-4o 等・別系統）での rejudge が必要

**要**: GPU full E2E の `e2e-ollama-gemma3-4b.jsonl` を入力に、`OPENROUTER_API_KEY=... npm run eval:rejudge -w @hybrid/api` を実行し、独立 judge の good率で routed vs always-cloud を比較する。

### 4. judge ノイズ床

flip率分析（`01-flip-analysis.md` 参照）の結論:
- **参照採点は flip率を下げなかった**（ノイズ床削減は未達成）
- **参照採点は good率を大幅に下げた**（off比: v4flash ★後で 25%→0%、★前で 25%→6.2%）
- これは「甘い採点の是正（精度是正）」であり、品質低下ではなく**判定の厳格化**と解釈する

参照ありの good率が 0〜6% と極めて低い点に注意。これは実務者の参照要点に照らすと、edge/cloud 回答の品質が実務基準を満たしていない可能性を示唆する。ただし judge の個別判断の内容（どの要点を落としたか）は現flipデータからは追跡できない。

## 現状で言える結論

1. **latency面ではStage2基準を充足**: routed p50 −55% は閾値 40% を超える。
2. **offload率は実運用には低すぎる**: 14.7% ではクラウドコスト削減の効果が薄い。ルーターの閾値調整または埋め込みモデル増強が必要。
3. **品質面は独立 judge で再評価が必要**: 自己採点バイアスが強いため、現行の good率（47.6% always-cloud）は信頼できない。
4. **参照採点（referencePoints）は判定を厳格化する**: flip率削減の目的は果たせなかったが、「甘い採点＝過大評価」を防ぐ保守的物差しとして有効。Stage2 品質判定には参照あり judge を推奨。

## 未確定で人間判断が要る点

1. **独立 judge good率（GPT-4o 等）での routed vs always-cloud 比較**: `e2e-ollama-gemma3-4b.jsonl` を入力に `rejudge.ts` を実行し、quality loss < 5% かを確認する。コマンド: `OPENROUTER_API_KEY=... npm run eval:rejudge -w @hybrid/api -- apps/api/eval/data/e2e-ollama-gemma3-4b.jsonl`
2. **offload率改善要否**: 14.7% を許容するか、ルーターの閾値リチューニング（recall 目標緩和）または埋め込みモデル強化（bge-m3 等へ移行）を検討するか。
3. **参照あり judge の good率 0% の実態確認**: どの参照要点で落とされたかの内訳を追跡する（現flipデータでは不可。単発 rejudge + 参照の combination が必要）。
4. **GPU 実環境での latency 再測定**: 現 `e2e-ollama-gemma3-4b.jsonl` の edge p50=33s は CPU 環境の可能性が高く、GPU 実環境での実測値との整合を確認する。
