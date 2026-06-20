# 19 edge候補モデル比較結果（llama3.1:8b / llama3.2:3b / granite4-micro vs gemma3:4b）

2026-06-18 起票。`out/18` の検証マトリクスに沿い、prod 配備可能な edge候補を GPU(RTX A5000)で
A 120件 edge生成 → 独立 judge(GPT-4o)参照採点。`out/17` の gemma3:4b baseline と同指標で比較。

## 実行条件

- edge生成: Ollama（RunPod, `E2E_ONLY_EDGE=1`, A 全120件）。各モデル md5照合済。
  - llama3.1:8b / llama3.2:3b / granite4:micro-h（= Workers AI `granite-4.0-h-micro` 相当）
- 採点: 独立 judge `openai/gpt-4o`。参照採点=77件（approved cloud）、edge想定41件は参照なし。
  - good = `factual && !overreach && sufficient`。全モデル同条件＝比較は公平。

## 結果

| モデル | 全good率 | edge想定good | cloud想定good | hallu | partial | refusal |
|---|---|---|---|---|---|---|
| gemma3:4b（baseline） | **13.3%** | **36.6%** | 1.3% | 57 | 42 | 4 |
| llama3.2:3b（対照） | 0.8% | 0.0% | 1.3% | 89 | 13 | 16 |
| llama3.1:8b（本命） | 5.8% | 14.6% | 1.3% | 54 | 17 | 40 |
| granite4-micro-h | 5.8% | 14.6% | 1.3% | 83 | 24 | 2 |

## 結論: 仮説否定、gemma3:4b が最良

「8B 増量で hallucination 改善」は**外れ**。gemma3:4b が全モデル中ベストで、増量・別系列はすべて悪化。

### サイズ効果 vs 系列効果の分離（対照群 llama3.2:3b の威力）

- **系列効果（同~3-4B）**: gemma3:4b 36.6% vs llama3.2:3b 0.0% → **系列差が支配的**。
  同サイズで Google Gemma が Meta Llama を圧倒。
- **サイズ効果（同Meta系列）**: llama3.2:3b 0.0% → llama3.1:8b 14.6% → サイズは効くが、
  **8Bでも gemma3:4b(4B) に届かない**。

→ **律速はサイズではなくモデル系列**。対照群が無ければ gemma3:4b(13.3%)→llama3.1:8b(5.8%) を見て
「8Bで悪化?」と誤読していた。対照群が交絡を解いた。

### Llama の失敗パターン

llama3.1:8b は refusal=40（「施設にご確認ください。」のみを返す。genFailed=False の真の拒否）。
日本語介護ドメインで Llama は拒否連発＋ハルシネーション。gemma は誤答もあるが易問は当てにいく。

## 戦略の転換

1. **edge モデルは gemma3:4b 据え置きが最適**（小型の中で最良）。乗り換え不要。
2. **~13% offload 天井は非グラウンディングな小型モデルでは突破不能**なドメイン制約と確定
   （`17` のフロンティアが小型モデルの上限）。
3. **真のレバーはモデル交換ではなく RAG/グラウンディング**。全モデル共通の主因が
   ドメイン知識欠如によるハルシネーション。edge に出典を渡せば factual エラーを潰せる。
   → 次は `09-edge-quality-improvement-plan.md` / `10-phase0-incontext-probe.md` の RAG 方向。

## 成果物

- rejudge 出力（answer+verdict 付き120件×3）:
  - `data/rejudge-judge-openai-gpt-4o-e2e-ollama-llama3-1-8b-edgeonly.jsonl`
  - `data/rejudge-judge-openai-gpt-4o-e2e-ollama-llama3-2-3b-edgeonly.jsonl`
  - `data/rejudge-judge-openai-gpt-4o-e2e-ollama-granite4-micro-h-edgeonly.jsonl`
- 生成JSONL（gitignore対象）は rejudge 出力に answer 同梱で保全。
