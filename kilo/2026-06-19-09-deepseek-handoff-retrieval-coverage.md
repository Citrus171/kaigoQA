# DeepSeek handoff: retrieval 網羅性の検証/改善（out/27）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: 実RAGの律速＝retrieval網羅性を定量化し、k掃引で改善余地を測る。

> 前提（必ず読む）: `apps/api/eval/out/26-rag-mvp-result.md`（再測定節）と `out/24`（再測定注記）、memory `selective-routing-pivot`。
> 2026-06-19 の同一judge再測定で確定したこと:
> - 実RAG(k=5) の retrieval loss は edge **−17.1pt** / cloud **−22.0pt**（oracle=全ref注入比）。
> - retrieval条件では **selective routing の優位が消滅**（real-selective天井=39.0%=real-cloud, edge上乗せ0）。
> - **真因 = recall定義と judge基準の不整合**。現 recall は「質問の referencePoints のうち **1個でも** top-k に入れば hit」（`rag-mvp.py` L128 `if gid in {s for s,_,_ in top}`）。一方 judge の sufficient は **全要点カバー**を要求。だから recall@5=95.1% でも k=5 では全要点が揃わず答案が情報不足→ bad。

## 背景データ（流用・再生成不要）
- corpus=573 chunks（120質問の全referencePointsを1点=1chunk化。`build_corpus`）。各chunk の `src_id`=質問id。
- embed キャッシュ `data/rag-corpus-embeddings.json`（bge-m3, dim=1024）**再embed不要**。
- judge は **必ず全 referencePoints(gold) で採点**（out/26で確定した唯一の正しい軸）。`rejudge-out26.py` の `judge()`/`isgood()` をそのまま流用。temp=0。
- 評価対象 = gold-a `expected=="edge"` の41件。

## Phase 1（安い・生成不要が本丸）: coverage 指標の再定義と k 掃引

`rag-mvp.py` の `compute_recall_at_k`（L119）を**置き換えず別関数**で拡張し、新スクリプト `apps/api/eval/retrieval-coverage.py` を作る。

各質問 i は M_i 個の referencePoint chunk を持つ（同一 src_id の chunk が corpus 内に M_i 個）。top-k 検索結果のうち src_id==i の chunk 数を hit_i とし、以下を k∈{5,8,12,16,20,30} で測る:

1. **hit-rate@k（現定義・比較用）**: top-k に src_id が1個でも入った質問率。
2. **coverage@k（新・主指標）**: 平均 `hit_i / M_i`（全要点のうち何割が top-k に入ったか）。
3. **full-coverage@k**: `hit_i == M_i`（全要点が揃った）質問の率。← judge の sufficient に最も近い。
4. 参考: M_i の分布（min/median/max）。要点数が多い質問ほど k を食う。

→ 出力: k × {hit-rate, coverage, full-coverage} の表。現 recall@5=95.1%(hit-rate) に対し full-coverage@5 がどれだけ低いかを可視化する（これが retrieval loss の機械的説明になる）。

## Phase 2（重い・Phase1 で改善余地が見えたら）: 生成での検証

full-coverage が大きく上がる k（例: k=12 or 16）で edge/cloud を**再生成**し、全ref judge で good 率を再測定。out/26 の real 条件（edge 14.6% / cloud 39.0% / selective 39.0%）がどこまで回復するかを見る。

- 生成は `rag-mvp.py` の `gen_edge`/`gen_cloud`（Workers AI / OpenCode）流用。`RAG_K` 環境変数で k 可変（L24 `RETRIEVAL_K`）。
- 出力 jsonl は `data/rag-mvp-edge-k{N}.jsonl` 等に分けて上書き衝突を避ける。
- 採点は **全ref judge**（retrieval参照でなく gold）。`rejudge-out26.py` 方式。
- 2×2 と real-selective 天井を out/26 と同形式で再計算。

## 成果物
- `apps/api/eval/retrieval-coverage.py`（Phase1。生成不要・安い）
- `apps/api/eval/out/27-retrieval-coverage.md`:
  - Phase1: k 掃引表（hit-rate vs coverage vs full-coverage）＋ M_i 分布＋考察
  - Phase2（実施した場合）: k=N での good率/2×2/real-selective 天井の回復幅
- 判定: full-coverage を上げれば good が回復するか＝**retrieval が律速か、それとも generation(reasoning failure 68.3%)が真の天井か**の切り分け。

## 注意・やらないこと
- **チャンク設計の変更（referencePoint の結合/分割）は今回スコープ外**。まず現 chunk 粒度のまま k 掃引で切り分ける。粒度変更は out/27 の結果を見て別 handoff。
- judge を retrieval 参照で採点する旧方式に**戻さない**（out/26 の汚染の元）。常に全ref。
- 完了後 Claude が out/27 を機械検算（coverage 計算・good 集計）し、次タスク（chunk設計 or generation改善 or #08拡充）を数値で判断。

関連: out/24 / out/26 / `rejudge-out26.py` / [[selective-routing-pivot]] / [[edge-quality-ceiling-gemma3]]
