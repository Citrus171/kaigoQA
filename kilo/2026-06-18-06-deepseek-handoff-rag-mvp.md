# DeepSeek handoff: 実RAG MVP（retrieval 評価）

作成 2026-06-18 / Claude → Kilo(DeepSeek)。
**タスク**: oracle参照注入を**実検索(retrieval)**に置き換え、retrieval品質の律速を測る。
これまでの全数値（cloud+RAG 63.4% / edge+RAG 36.6% / oracle 70.7%）は**正解のreferencePointsを直接投入した理想RAG**。
本タスクで「質問から実際に検索した参照」でどこまで品質を保てるか＝**実運用の最大の未検証ポイント**を埋める。

## 設計（最小で正当な評価ができる構成）

### コーパス（外部文書を新規作成しない）
- `apps/api/eval/data/routing-gold-a.jsonl` の **全120件の `referencePoints` を1点=1chunkとして全部混ぜる**。
- これにより、ある質問の検索時に**他119件分のpointsがノイズ**になり、recall@k が意味を持つ。
- 各chunk に出自 `src_id`（元質問id）を持たせる → 正解判定に使う（後述 recall）。
- chunk 総数 ≈ Σ(各質問の referencePoints 数)。重複pointは残してよい（実運用に近い）。

### 埋め込み / 検索
- embed = **bge-m3**（ollama `/api/embed`, dim 1024。既存ルーティングと統一）。
  ※ このPCはCPUで bge-m3 ≈ 5秒/件と遅い（[[local-cpu-edge-infeasible]]）。コーパスembedは一度だけ計算しキャッシュ(json)推奨。
- ストア = eval MVP は**インメモリ cosine**（120質問規模なら十分）。本番 pgvector 実装は別タスク。
- 検索 = 質問を embed → 全chunk と cosine → **top-k**（k=3,5,8 を比較）。

### 評価2層

**層1: retrieval 単体（生成不要・安い・先に出す）**
- `recall@k` = 質問 i の検索 top-k chunk のうち **src_id==i のchunkが1つ以上含まれる率**（正解参照を引けたか）。
- k=3/5/8 で recall@k を出す。retrieval が機能するかの一次判定。

**層2: end-to-end（生成あり = Kiloの生成作業）**
- 検索した top-k chunk を参照として注入し、**edge(Gemma4 26B Workers AI thinkOFF)** と **cloud(deepseek-v4-flash)** で再生成 → gpt-4o judge（参照あり採点）。
- 既存スクリプトの「oracle参照注入」を「top-k検索参照」に差し替えるだけ:
  - edge: `apps/api/eval/phaseA-gemma4-incontext.py`（`reference_of` を retrieval結果に置換、`EVAL_SET=edge`）
  - cloud: `apps/api/eval/measA-cloud-rag.py`（同様に refs を retrieval結果に）
- **retrieval loss** = oracle参照版 good率 − 実RAG版 good率（edge / cloud それぞれ）。
  - 期待: cloud oracle 63.4% / edge oracle 36.6% に対し、実RAGがどれだけ落ちるか。loss が小さいほど retrieval が良い。

**層3: 故障分離 2×2（retrieval failure vs reasoning failure）← 本タスクの目玉**
- 各件を oracle参照版 good と 実RAG版 good の組合せで4象限に分類（edge / cloud それぞれ別表で）:

  | | 実RAG good | 実RAG bad |
  |---|---|---|
  | **Oracle good** | 検索も推論もOK | **retrieval failure**（検索が引けず劣化＝検索改善で直せる） |
  | **Oracle bad** | （稀） | **reasoning/capacity failure**（モデル/知識の限界＝検索では救えない） |

- これにより「品質の伸びしろが retrieval 側か model 側か」を**定量で切り分ける**。
  - retrieval failure が多い → chunk設計/k/embed改善に投資すべき
  - reasoning failure が多い → 検索を磨いても無駄、edgeモデル増強 or cloud escalate が必要
- 既存知見と接続: oracle bad は [[selective-routing-pivot]] の「両方bad 29%／失敗は全partial＝capacity天井」と同一現象。
  実RAG導入で **retrieval failure** が新たに乗る分が「理想と現実の差」。
- out/26 に **edge版・cloud版それぞれの 2×2 件数表** と、retrieval/reasoning 各failureの件数・割合を記載。

## 対象
- edge想定41件（`expected==edge`）で測る（measと同集合・直接対比可）。判定は gpt-4o judge・参照あり（既存と同一基準）。

## 成果物
- `apps/api/eval/rag-mvp.py`（コーパス構築＋embedキャッシュ＋retrieval＋recall@k。層1まで完結）
- `apps/api/eval/data/rag-corpus-embeddings.json`（bge-m3 embedキャッシュ。CPU遅いので再利用）
- `apps/api/eval/data/rag-mvp-edge.jsonl` / `rag-mvp-cloud.jsonl`（層2の生成＋判定結果）
- 記録 `apps/api/eval/out/26-rag-mvp-result.md`（recall@k 表 + retrieval loss 表 + 結論）

## retrieval スケルトン（層1）
```python
import json, requests, math, os
gold=[json.loads(l) for l in open('apps/api/eval/data/routing-gold-a.jsonl') if l.strip()]
# コーパス: 全referencePointsをchunk化（src_id付き）
corpus=[{"src_id":g["id"],"text":p} for g in gold for p in (g.get("referencePoints") or [])]
def embed(texts):
    r=requests.post("http://localhost:11434/api/embed",json={"model":"bge-m3","input":texts},timeout=300)
    return r.json()["embeddings"]
def cos(a,b):
    d=sum(x*y for x,y in zip(a,b)); na=math.sqrt(sum(x*x for x in a)); nb=math.sqrt(sum(y*y for y in b))
    return d/(na*nb) if na and nb else 0.0
# 1) corpus embed（キャッシュ推奨）/ 2) 各質問embed→cosine top-k / 3) recall@k = src_id一致がtop-kにあるか
```

## 注意 / コツ
- **CPU embed が遅い**（bge-m3 ≈5秒/件）。コーパス embed は1回だけ→json保存→以降ロード。gemma4:e4b等を**同時にロードしない**（CPU競合でembedが更に激遅 [[local-cpu-edge-infeasible]]）。
- 層1(recall@k)を先に出す＝生成コスト0で retrieval の生死が分かる。recall が低ければ chunk設計(分割/k)を調整してから層2へ。
- edge候補41件は元々 referencePoints が approved 揃い（[[selective-routing-pivot]] の前提と同集合）。
- 数値が出たら out/26 へ。Claude が機械検算してから確定。

関連 [[selective-routing-pivot]] [[deepseek-handoff-default]] [[local-cpu-edge-infeasible]]
