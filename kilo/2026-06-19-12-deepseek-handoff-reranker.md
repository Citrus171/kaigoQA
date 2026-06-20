# DeepSeek handoff: reranker 導入で検索精度を上げる（out/30）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: bge-m3 cosine 検索に cross-encoder reranker を足し、top-1 gid 含有率（現 65.9%）を上げられるか検証する。

> ## 🔴 鉄則（必読・memory `eval-oracle-asymmetry-pitfall`）
> **real が oracle（理論上界 cloud=61.0%）を超えたら、改善でなく評価バグ（oracle と生成入力/judge の非対称）を疑い、停止して報告する。**
> judge は常に全ref(gold)・temp=0 固定。生成入力規模は oracle（質問あたり M≈4.9 refs）と同オーダーに揃える。out/26(judge非対称)・out/28(生成入力14×)で2回踏んだ。

## 背景（out/29 で確定したこと）
- cloud real 46.3% / 天井(oracle) 61.0%。差 −14.7pt のうち retrieval failure 19.5% が検索律速。
- 真因＝**検索精度そのもの**: bge-m3 cosine の **top-1 unique src_id 含有率は 65.9%**（自質問の chunk が他質問の chunk に上位を奪われる）。
- k 拡大・parent-document 化は出尽くした（対称条件で改善ゼロ）。→ 順位付けを直す reranker が次の一手。

## 設計
1. **粗選**: 既存 bge-m3 embed（`data/rag-corpus-embeddings.json`・573 chunks・**再計算不要**）で cosine top-K 候補を取る（**K=30**）。
2. **rerank**: **Cloudflare Workers AI の `@cf/baai/bge-reranker-base`**（HTTP・GPU実行。**ローカル torch / FlagEmbedding は不要**＝install待ち回避。このPCはGPUなし＝[[local-cpu-edge-infeasible]] のためローカル CPU rerank は避ける）。
   - 既存 `CF_ACCOUNT_ID`/`CF_API_TOKEN`（`rag-mvp.py` L46-49 と同じ env）を流用。edge(gemma) と同じ経路。
   - API: `POST https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/@cf/baai/bge-reranker-base`、body `{"query": q, "contexts": [{"text": chunk_text}, ... 30件], "top_k": 30}`。レスポンスは各 context の `index` と `score`(sigmoid[0,1])。**score 降順**で並べ替え → top-N。
   - 呼び出しは **41質問 × 1 call(30 contexts) = 41 HTTP のみ**（軽い。レイテンシ次第で並列化可。cloud API律速に注意＝[[gpu-e2e-edge-cloud-split]]）。
   - レスポンスの `index` は contexts 配列の添字なので、粗選 top-30 の chunk と src_id へ正しくマップすること。
3. 出力: rerank 後の順位。

## Phase 1（安い・生成不要が本丸）
rerank 後の検索指標を bge-m3 単体と並べて測る（`retrieval-coverage.py` の指標計算を流用）:
- **top-1 unique src_id 含有率**（主指標。現 65.9% がどこまで上がるか）
- top-3 含有率 / full-coverage@N
- → ここで有意に上がらなければ reranker は効かないと判定し、chunk 粒度変更（別handoff）へ。生成はしない。

## Phase 2（Phase1 で改善が見えたら）
- 改善した検索で **cloud(deepseek-v4-flash) を再生成 → 全ref judge → 2×2**（oracle_cloud vs real）。
- 生成入力は out/29 と同じ **N=1 相当（rerank 後 top-1 src_id の親 = 自質問の全ref オーダー）**。生成入力件数を必ず記録し oracle と並記（非対称チェック）。
- oracle 基準 = `data/rejudge-out26-verdicts.json` の `oracle_cloud`。
- retrieval failure 8件（gold-A-006,013,014,027,030,038,039,042）のうち何件救済されるか。
- judge は `rejudge-out26.py` の judge() 流用・全ref固定。

## 成果物
- `apps/api/eval/reranker-eval.py`（Phase1+2）
- `data/rag-corpus-rerank.json`（rerank スコア/順位キャッシュ・再実行用）
- 改善時のみ `data/rag-mvp-cloud-rerank.jsonl`
- `apps/api/eval/out/30-reranker.md`: bge-m3 単体 vs reranker の top-1/top-3/full-coverage 比較表 / 生成入力件数(oracle並記) / 2×2 / retrieval failure 救済数 / 判定（reranker は効くか）

## やらないこと
- 生成入力を oracle より大きいオーダーにする（out/28 の轍）。
- embed の再計算（reranker は粗選候補を並べ替えるだけ。embed cache 流用）。
- edge 再生成 / generation 改善 / #08（順序通り後段）。
- judge を retrieval 参照採点に戻す。

完了後 Claude が out/30 を機械検算（top-1 gid率の独立再計算・生成入力対称性・2×2・救済突合）し、reranker 採否と次（chunk粒度 or generation改善）を数値判断。

関連: out/27 / out/29 / `retrieval-coverage.py` / `rejudge-out26.py` / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]] / [[local-cpu-edge-infeasible]]
