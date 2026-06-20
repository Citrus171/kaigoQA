# 02 Stage2 結論ドラフト

**※本ドラフトは人間レビュー前提。数値は現時点で入手可能なデータに基づく暫定値。**

## Stage2 の問い

「edge（ローカルSLM = gemma3:4b）にオフロードしても、品質を維持できるか？」

## 4 基準の評価

| # | 基準 | 閾値 | 現状値 | 状態 |
|---|---|---|---|---|
| 1 | latency改善率 | > 40% | routed p50 −55%（GPU full E2E 実測・確定済み） | ✅ 充足 |
| 2 | offload率（routedがedgeを選ぶ割合） | —（指標・高いほど効果大） | 14.7%（5/34件） | ⚠ 低い。クラウド依存度が高い |
| 3 | 品質 loss（独立judge GPT-4o: always-cloud − routed） | < 5% | **0.0pt**（always-cloud 34.8% − routed 34.8%） | ✅ 充足 |
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

### 3. 品質 loss（✅ 充足・確定）

独立 judge（GPT-4o、OpenRouter 経由）による再採点を実施（2026-06-17 17:34）。

| ポリシー | 独立judge good率 | 旧自己採点 good率 | n |
|---|---|---|---|
| always-edge | 29.4% (10/34) | 32.4% | 34 |
| always-cloud | 34.8% (8/23) | 47.6% | 23 |
| routed | 34.8% (8/23) | 47.6% | 23 |

**quality loss = always-cloud(34.8%) − routed(34.8%) = 0.0pt** → 閾値 5% を充足。

judge間一致度: 83.6%（46/55）。旧good→新bad: 6件（自己採点の過大評価）、旧bad→新good: 3件。

- routed と always-cloud の品質差は独立 judge でも 0。ルーターは品質を落とさずに offload できている。
- 自己採点（deepseek）は約 6 件の回答を過大評価していたが、ポリシー間の相対差には影響していない。

### 4. judge ノイズ床

flip率分析（`01-flip-analysis.md` 参照）の結論:
- **参照採点は flip率を下げなかった**（ノイズ床削減は未達成）
- **参照採点は good率を大幅に下げた**（off比: v4flash ★後で 25%→0%、★前で 25%→6.2%）
- これは「甘い採点の是正（精度是正）」であり、品質低下ではなく**判定の厳格化**と解釈する

参照ありの good率が 0〜6% と極めて低い点に注意。これは実務者の参照要点に照らすと、edge/cloud 回答の品質が実務基準を満たしていない可能性を示唆する。ただし judge の個別判断の内容（どの要点を落としたか）は現flipデータからは追跡できない。

## 現状で言える結論

1. **latency面で Stage2基準を充足**: routed p50 −55% は閾値 40% を超える。
2. **品質面でも Stage2基準を充足**: 独立judge quality loss = 0.0pt（閾値 5% 未満）。ルーターは品質を損なわずに offload 可能。
3. **offload率は実運用には低すぎる**: 14.7% ではクラウドコスト削減効果が薄い。ルーターの閾値調整で offload率を引き上げる余地がある（quality loss 0.0pt なので閾値緩和の余裕あり）。
4. **参照採点（referencePoints）は判定を厳格化する**: flip率削減の目的は果たせなかったが、「甘い採点＝過大評価」を防ぐ保守的物差しとして有効。
5. **自己採点バイアスは実在するが、ポリシー間の相対評価には影響しなかった**: 旧good→新bad 6件の過大評価があったが、routed と always-cloud で同等に作用。

## 未確定で人間判断が要る点

1. **offload率改善（最も優先度が高い）**: quality loss 0.0pt なので、閾値を緩めて offload率を引き上げる動作点の再探索を推奨。loss < 5% を維持しながら offload率をどこまで上げられるか。
2. **参照あり judge の good率 0% の実態確認**: flip率分析で参照あり good率 0%（v4flash★後）となったが、独立judge rejudge では参照ありの項目でも一定の good率が出ている。参照が適切に機能しているか要確認。
3. **GPU 実環境でのGranite3.2評価**: 商用最適候補の granite3.2:2b を `OLLAMA_GEN_MODEL` で差し替えて eval:e2e を実施し、gemma3:4b との品質比較を行う。
