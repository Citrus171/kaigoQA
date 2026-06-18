# 18 Workers AI edge候補モデル調査（granite8b 検証の前提固め）

2026-06-18 起票。`out/17` の結論「edge モデル品質が律速」を受け、prod edge 想定の
Cloudflare Workers AI で**実際に配備可能な**モデルと料金/制約を出典付きで確認した。

## 最重要: granite-8b は Workers AI に無い

Workers AI の IBM Granite は **`@cf/ibm-granite/granite-4.0-h-micro`**（micro=小型）のみ。
前回 `12-granite8b-results.md` の granite-8b は **GPU ローカル専用で prod 配備不可**。
→ 検証対象を「実際に Workers AI で動くモデル」に組み替える。

## prod 配備可能な edge候補（≤8B）と料金

レート: $0.011 / 1,000 neurons、無料枠 10,000 neurons/日。

| モデル | サイズ | 出力 neurons/Mtok | $/M出力換算 | 備考 |
|---|---|---|---|---|
| granite-4.0-h-micro | micro(小) | 10,158 | $0.112 | 最安。IBMはRAG/edge向けと主張 |
| llama-3.2-1b-instruct | 1B | 18,252 | $0.201 | 最小 |
| llama-3.2-3b-instruct | 3B | 30,475 | $0.335 | gemma3:4b と同クラス |
| llama-3.1-8b-instruct-fast(fp8) | 8B | 34,868 | $0.384 | 8B最速・現実的本命 |
| llama-3.1-8b-instruct(full) | 8B | 75,147 | $0.827 | 高い |

入力側 neurons/Mtok（参考）: granite-micro 1,542 / l3.2-1b 2,457 / l3.2-3b 4,625 /
l3.1-8b-fast 4,119 / l3.1-8b-full 25,608。

## レイテンシ

Workers AI はサーバーレス推論で**ハードな上限SLAは非公表**。`-fast`/`fp8` 変種が速度最適化版
（例: llama-3.1-8b-instruct-fast）。実レイテンシは GPU 検証時に実測する。

## 検証計画の更新（本命の組み換え＋対照群の必須化）

- **本命を granite8b → `llama-3.1-8b-instruct-fast` に変更**。gemma3:4b(4B) が hallucination で
  失敗した以上、8Bクラスへの増量が hallucination 削減に最も効く見込み。fp8-fast で価格も中庸。
- **`llama-3.2-3b` を「対照群」として必須化**（旧計画では「余力で」としていたが格上げ）。

### なぜ llama-3.2-3b が必須か（サイズ効果 vs 系列効果の分離）

gemma3:4b → llama-3.1-8b は**サイズ(4B→8B)と系列(Google→Meta)が同時に変わる**ため、改善しても
原因を分離できない。llama-3.2-3b が両軸をつなぐ要になる:

- gemma3:4b ↔ **llama-3.2-3b**（同サイズ3-4B・別系列）= **系列効果**を分離
- **llama-3.2-3b** ↔ llama-3.1-8b（同系列Meta・別サイズ）= **サイズ効果**を分離

これを欠くと次モデル選定で同じ調査を繰り返すことになる。

### 検証マトリクス

| モデル | 優先度 | 位置づけ |
|---|---|---|
| llama3.1:8b-fast | ★★★ 必須 | 本命。8B級の上限を見る |
| llama3.2:3b | ★★★ 必須 | 対照群。サイズvs系列を分離 |
| granite-4.0-h-micro | ★★☆ 推奨 | 最安($0.112/Mtok)。**llama3.1:8b がコスト/レイテンシで落ちた場合の次善策**として検証 |
| gemma3:4b | 済 | baseline（今回の120件） |

### 次の GPU セッション手順（proxy）

Ollama で近い proxy が揃う。`17` の baseline と同指標で比較:

1. `llama3.1:8b`（本命）+ `llama3.2:3b`（対照群）で A-dev edge生成（`E2E_ONLY_EDGE=1`）→ 同じ参照採点 rejudge
2. granite-4.0系（Ollama に近接モデルがあれば）を次善策として
3. 比較指標: edge-good率（expected別）/ hallucination件数（baseline 57）/ offload-品質フロンティア

> 注: Ollama proxy と Workers AI 実モデルは量子化・配信が異なるため代理値（`17` の但し書きと同前提）。

## 出典

- https://developers.cloudflare.com/workers-ai/models/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
