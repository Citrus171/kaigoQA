# DeepSeek handoff: out/24 selective routing 天井（oracle）を記録

作成 2026-06-18 / Claude → Kilo(DeepSeek)。
**タスク**: `apps/api/eval/out/24-selective-routing-ceiling.md` を新規作成し、下記の検算済み分析を記録する。
数値は Claude が下記2ファイルから機械計算済み（計算式も明記）。Kilo は再計算で照合のうえ md に整形してほしい。

## 背景（out/22→23→24 の流れ）

- out/22: SLO 凍結。SLO-1 = edge振り分け分 good率 ≥ always-cloud − 5pt（品質最優先）。
- out/23: cloud baseline 測定。always-cloud(参照なし)=7.5% / cloud+RAG=63.4% / edge(Gemma4 26B+RAG)=36.6%。
  → ケースB（同RAG下のモデル能力差）で edge は cloud に **−26.8pt**。**edge 全振りは SLO-1 未達**。
- **out/24（本書）**: ならば「edge が確実に good な件だけ edge、不確実は cloud へ escalate」する
  **selective capability routing** の**理論上限（oracle）**を試算し、設計が成立するか判定する。

## データソース（edge候補=gold-a expected==edge の 41件）

| 役割 | ファイル | 取り出すフィールド |
|---|---|---|
| edge 件別 good | `apps/api/eval/data/phaseA-gemma4-incontext-results-edge-thinkoff.json` | `items[].id`, `items[].new_good`（Gemma4 26B A4B thinkOFF + 参照注入） |
| cloud+RAG 件別 good | `apps/api/eval/data/measA-cloud-rag-edge.jsonl` | `id`, `good`（deepseek-v4-flash + 参照注入） |

両ファイル 41件・`id` で 1:1 join 可能。採点はいずれも gpt-4o judge・参照あり（同一基準）。

## 検算済み数値（Kilo はこの計算式で再現照合）

各件 `e = edge_good`, `c = cloud_good` とする。

| 戦略 | 定義 | good | offload |
|---|---|---|---|
| all-edge | 全件 edge | 15/41 = **36.6%** | 100% |
| all-cloud+RAG | 全件 cloud（routing なし） | 26/41 = **63.4%** | 0% |
| **oracle-selective** | e=True は edge、それ以外 cloud（完全予測器） | 29/41 = **70.7%** | **37%**（=edge_good件をedgeへ） |

- oracle-selective の good = `sum(e or c)` = 29。offload = `sum(e)/41` = 15/41 ≈ 37%。
- **oracle-selective の quality 変化 vs always-cloud(+RAG): 63.4% → 70.7% = +7.3pt**（offload 37% を稼ぎつつ品質は cloud 以上）。

### クロス集計 (edge_good, cloud_good)

| 区分 | 件数 | 含意 |
|---|---|---|
| edge=True, cloud=True | 12 | 両方good＝edgeで肩代わり可（コスト削減の核） |
| edge=True, cloud=False | 3 | **edgeのみgood**＝edge固有価値（小さい） |
| edge=False, cloud=True | 14 | **cloudのみgood＝escalate必須**（最大カテゴリ34%、selectiveで拾う本丸） |
| edge=False, cloud=False | 12 | **両方bad（29%）**＝RAGでも両者解けない構造的難所（routingでは救えない） |

## 記録すべき解釈（3点）

1. **selective routing は成立**。oracle 天井 = offload 37% で品質 cloud 超え(+7.3pt)。完全予測器が前提のため、
   現実は confidence 予測器の精度次第で 70.7% から劣化する（次タスク=予測器設計）。
2. **両方bad 29%** = edge候補ですら3割は誰も解けない → routing 以前に**参照/データ品質 or 採点厳しさ**の課題が残る。
3. **edge固有good=3件のみ** → edge の存在意義は品質向上でなく**コスト削減**と再確認（SLO-3整合）。

## 次タスクへの橋渡し（out/24 末尾に記載）

- confidence 予測器の設計: どのシグナル（埋め込み類似度・カテゴリ・回答長・self-consistency 等）で
  edge_good を事前判定するか。oracle 70.7% にどこまで迫れるかが本丸。
- 関連: [[edge-quality-ceiling-gemma3]] [[gpu-e2e-edge-cloud-split]]

## 検証（Kilo 実行）

```bash
python3 - <<'PY'
import json
from collections import Counter
edge={it['id']:it['new_good'] for it in json.load(open('apps/api/eval/data/phaseA-gemma4-incontext-results-edge-thinkoff.json'))['items']}
cloud={json.loads(l)['id']:bool(json.loads(l)['good']) for l in open('apps/api/eval/data/measA-cloud-rag-edge.jsonl')}
ids=sorted(set(edge)&set(cloud)); n=len(ids)
eg=sum(edge[i] for i in ids); cg=sum(cloud[i] for i in ids); orc=sum(1 for i in ids if edge[i] or cloud[i])
cc=Counter((edge[i],cloud[i]) for i in ids)
print(n, eg, cg, orc, dict(cc))
# 期待: 41 15 26 29 {(F,T):14,(T,T):12,(F,F):12,(T,F):3}
PY
```
期待出力: `41 15 26 29 {(False,True):14,(True,True):12,(False,False):12,(True,False):3}`
