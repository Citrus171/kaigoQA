# 17 Dataset A edge品質結果（Ph4: 参照採点 rejudge）

2026-06-18 起票。Dataset A 全120件で GPU(gemma3:4b) edge答案を生成し、独立 judge(GPT-4o)で
**参照採点**して edge 品質を確定した結果。結論は「**閾値問題ではなく edge モデル品質問題**」。

## 実行条件

- edge生成: Ollama `gemma3:4b`（RunPod RTX A5000, `E2E_ONLY_EDGE=1`）。120件・md5照合済。
  - 出力: `data/e2e-ollama-gemma3-4b-edgeonly.jsonl`
- 振り分け: `bge-m3` centroid（生成時点のモデル）。
- 採点: 独立 judge `openai/gpt-4o`（OpenRouter）。参照採点=77件（approved cloud referencePoints）、
  残り43件（主に edge-expected・未承認）は参照なし採点。
  - 出力: `data/rejudge-judge-openai-gpt-4o-e2e-ollama-gemma3-4b-edgeonly.jsonl`
- good 判定 = `factual && !overreach && sufficient`。

## 結果1: edge答案 good率（expected別）

| expected | edge-good率 | 件数 |
|---|---|---|
| edge（易しい想定） | **36.6%** | 15/41 |
| cloud（難しい想定） | **1.3%** | 1/79 |
| 全体（always-edge） | **13.3%** | 16/120 |

→ 易しい edge-expected ですら gemma3:4b は37%しか正答できない。難問は壊滅。

## 結果2: 振り分け × edge品質 クロス集計（生成時 routing）

| 状態 | 件数 | 評価 |
|---|---|---|
| routed=edge & edge良 | 15 | ✅ 正しく edge 維持 |
| routed=edge & edge悪 | 46 | ❌ 品質損失（本来 cloud） |
| routed=cloud & edge良 | 1 | △ 過剰escalate |
| routed=cloud & edge悪 | 58 | ✅ 正しく escalate |

routed good率 = 15/61 = 24.6%。embedding 類似度は「gemma3 が実際に正答できるか」を予測できていない
（routed=edge の 46件が品質損失）。

## 結論

1. **edge品質が天井**。良い edge答案は全120件中わずか16件。**品質維持での offload 上限 ≈ 13%**。
2. **閾値チューニングの余地は小さい**。−0.094 をどう動かしても、gemma3 が答えられる質問が16件しか
   ない以上、offload を増やすと品質が落ちる。閾値は edge 品質天井を超えられない。
3. **真のレバーは edge モデル増強**。

## 但し書き

gemma3:4b は代理値（prod edge = Workers AI 想定。`docs/e2e-gpu-runbook.md` 同前提）。
この13%天井は gemma3:4b 固有で、prod 想定モデルでは変わり得る。
過去の別モデル比較: `08-edge-model-comparison.md` / `12-granite8b-results.md`。

## 次ステップ

- **A（本筋）**: edge モデル増強検証。granite8b 等で同じ A-dev edge生成→参照採点し good率を比較。
  13%天井が動くかを定量化（GPU 再走が必要）。
- B（暫定）: gemma3:4b 前提で閾値だけ最終化（offload 低いまま受容）。投資価値は低い。

## .env の現運用点

`AI_ROUTER_THRESHOLD=-0.094`（A-dev/A-holdout の expected ラベル基準で確定済）。
本結果は「品質基準で見ると edge 自体が弱い」ことを示すが、ラベル基準の閾値選定自体は妥当。
最終運用点の品質込み確定は、edge モデル方針（A/B）決定後に行う。
