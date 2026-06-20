# 21 Gemma 4 26B A4B (Workers AI) 評価結果 — edge本命の確定

2026-06-18 起票。`out/19`（小型モデルは gemma3:4b が最良だが13%天井）と `out/18`（Workers AI に
小型 gemma 無し）の続き。Workers AI に **Gemma 4 26B A4B（MoE 4B-active）** が乗ったため prod 実機で評価。

## 背景・前提

- prod edge = Workers AI。Gemma 4 26B A4B（総26B/アクティブ4B、256K context、thinking mode）。
  料金 $0.10/M入力・$0.30/M出力（llama-3.1-8b より安く、26B級知識）。
- 評価は API 直叩き（GPU不要・prod実機そのもの）。EDGE_SYSTEM_PROMPT は既存と一字一句同一。
- judge = GPT-4o（OpenRouter, 参照採点）。gemma3:4b baseline と同条件。
- スクリプト: `eval/gemma4-workersai-edge.py`（生成）/ `eval/phaseA-gemma4-incontext.py`（参照注入）。

## 結果1: 素の120件（参照なし）

| モデル | 全good | edge想定 | cloud想定 | hallu | refusal |
|---|---|---|---|---|---|
| gemma3:4b | 13.3% | 36.6% | 1.3% | **57** | 4 |
| Gemma4-26B | 3.3% | 7.3% | 1.3% | **4** | **80** |

→ 一見 Gemma4 が低いが、内訳が逆。**ハルシネーション 57→4 に激減**し、代わりに refusal 80。
これは能力不足でなく **EDGE_SYSTEM_PROMPT の「確認できなければ施設へ」に Gemma4 が忠実に従った
deferral**（gemma3 は無視して捏造）。refusal答案は核心を当てつつ詳細を施設に委ねる正しい挙動。
→ **素の good率はプロンプト＋judge厳格さのアーティファクトで、capability を測れていない**。

## 結果2: 参照注入（oracle-RAG, 最難77件）= capability の真値

| 構成 | good率 |
|---|---|
| gemma3:4b 参照なし | 0.0% |
| gemma3:4b + 参照 | 27.3% (21/77) |
| **Gemma 4 26B + 参照** | **45.5% (35/77)**（+18.2pt） |

### category別（Gemma4+参照 vs gemma3+参照）

| category | Gemma4+参照 | gemma3+参照 |
|---|---|---|
| calc-benefit（算定） | 46% | 29% |
| procedure | 41% | 35% |
| boundary-case | 50% | 25% |
| system-explain | 43% | 21% |
| service-compare | 50% | 17% |

**全カテゴリで gemma3 を上回る**。最難の cloud想定77件で 45.5%（易しい edge想定41件は更に高い見込み）。

## 結論: Gemma 4 26B A4B + RAG が本命 edge stack

1. **4B 推論天井（gemma3 oracle 27%）を 45.5% に突破**。`out/17` の「13%天井」「推論限界が支配」は
   gemma3:4b 固有で、Gemma4 は破る。
2. **ハルシネーションほぼゼロ**（本プロジェクトの中心課題を解決）。
3. **prod配備可能**（Workers AI）・**コスト競合**（$0.30/M）。
4. `out/18` で挙げた「配備先の矛盾（Workers AIに gemma無し）」も解消。

## 残レバー（更に good率を伸ばす）

- **プロンプト調整**: over-deferral 抑制（一般制度知識は答える／施設固有・個別計算のみ defer）。
  現状 deferで落ちている項目（例 負担割合判定）が good 化する余地。
- **Tool route**: 純計算（限度額計算 gold-A-061 等）は `calculate_limit()` 等へ。LLMに計算させない。
- **latency**: thinking mode で p50 9秒/p95 22.6秒/max 38.7秒 → edge一次応答には重い。
  thinking off 版の品質・速度トレードオフを要検証（SLO 論点）。

## 次（Phase B）

- SLO 凍結（good率/offload/latency/cost）。latency は thinking on/off の選択に直結。
- アーキ確定: General(Gemma4) / RAG(Gemma4+検索) / Tool(計算) / Cloud-escalate の capability routing。
- 配備先モデル = Gemma 4 26B A4B（Workers AI）で確定方向。

## 成果物

- 生成: `data/e2e-workersai-gemma4-26b-a4b-edgeonly.jsonl`
- 参照採点: `data/rejudge-judge-openai-gpt-4o-e2e-workersai-gemma4-26b-a4b-edgeonly.jsonl`
- 参照注入結果: `data/phaseA-gemma4-incontext-results.json`
- gemma3 参照注入 baseline: `data/phaseA-incontext-results.json`（0→27.3%）
