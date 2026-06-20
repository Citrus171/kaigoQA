# DeepSeek handoff: chunk 粒度変更（質問単位結合）で検索精度を上げる（out/31）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: chunk を「1 referencePoint=1 chunk」から「1質問=1 chunk（全ref連結）」に変えて embed し直し、top-1 gid 含有率（現 65.9%）を上げられるか検証する。

> ## 🔴 鉄則（必読・memory `eval-oracle-asymmetry-pitfall`）
> **real が oracle（cloud=61.0%）を超えたら、改善でなく評価バグ（生成入力/judge の非対称）を疑い、停止して報告。**
> judge は常に全ref(gold)・temp=0 固定。生成入力規模は oracle（質問あたり M≈4.9 refs）と同オーダーに揃える。

## 背景（ここまでの確定）
- 律速 = 検索精度。bge-m3 cosine の top-1 unique src_id 含有率 65.9%（out/29）。
- 打ち手の結果: k拡大=頭打ち / parent-document=対称で改善ゼロ(out/29) / **reranker=−12.2pt悪化で打ち切り(out/30)**。
- 原因仮説: **1 referencePoint=1 chunk が細かすぎ**、同一質問の chunk が cosine 空間で離散し、他質問の chunk に top 位を奪われる。→ 検索単位を質問粒度に上げる。

## 設計
1. **新 corpus**: 各質問の全 referencePoints を**1つの chunk に連結**（区切りは改行か "。"）。120質問 → **120 chunks**（src_id=質問id, 1:1）。
2. **embed 再計算（必須・避けられない）**: bge-m3 で 120 chunk を embed。
   - **embed は Workers AI `@cf/baai/bge-m3` を推奨**（ローカル CPU は GPUなし=遅い [[local-cpu-edge-infeasible]]。Workers AI なら HTTP・GPU。`CF_ACCOUNT_ID`/`CF_API_TOKEN` 流用）。ただし **現 embed cache（573 chunk・粒度違い）とは別物**なので新規キャッシュ `data/rag-corpus-embeddings-qlevel.json` に保存。
   - ※ ollama bge-m3 でも可だが 120件でも CPU は遅い。Workers AI 優先。
3. **検索**: 質問を embed → 120 chunk と cosine → top-k。chunk=質問単位なので **top-1 src_id がそのまま「引けた質問」**。

## Phase 1（安い・生成不要が本丸）
- **top-1 / top-3 src_id 含有率**を、旧粒度（573 chunk, 65.9%/92.7%）と並べて測る。
- 質問単位なら full-coverage の概念は不要（chunk=全ref なので引けた=全要点入手）。
- → top-1 含有率が 65.9% から有意に上がるか。上がらなければ「検索の限界は粒度でなく embedding/クエリの問題」と判定し報告。

## Phase 2（Phase1 で改善が見えたら）
- 改善した検索で **cloud(deepseek-v4-flash) を再生成 → 全ref judge → 2×2**。
- 生成入力 = **top-1 src_id の chunk（=その質問の全ref連結 ≈ oracle の M件と同オーダー）**。N=1 のみ。生成入力件数を記録し oracle と並記（非対称チェック）。
- oracle 基準 = `data/rejudge-out26-verdicts.json` の `oracle_cloud`。
- retrieval failure 8件（gold-A-006,013,014,027,030,038,039,042）の救済数。
- judge は `rejudge-out26.py` の judge() 流用・全ref固定。

## 重要な比較の注意
- 旧 573-chunk corpus と新 120-chunk corpus では**検索空間が変わる**。Phase1 の含有率比較はそのまま意味を持つ（同じ41質問で top-1 が自質問か）が、レポートに **corpus 構成（chunk数・粒度）を明記**すること（out/27 の「200 chunks」誤記の二の舞を避ける）。
- 連結で chunk が長くなると embed が要点を薄める恐れ（粒度トレードオフ）。top-1 が上がっても full な情報が引けているかは Phase2 の good 率で確認。

## 成果物
- `apps/api/eval/chunk-granularity.py`
- `data/rag-corpus-embeddings-qlevel.json`（新 embed キャッシュ）
- 改善時のみ `data/rag-mvp-cloud-qlevel.jsonl`
- `apps/api/eval/out/31-chunk-granularity.md`: 旧/新粒度の top-1/top-3 含有率比較 / corpus構成明記 / 生成入力件数(oracle並記) / 2×2 / 救済数 / 判定

## やらないこと
- 生成入力を oracle より大きいオーダーにする（out/28 の轍）。
- reranker の再挑戦（out/30 で打ち切り）。
- edge 再生成 / generation 改善 / #08（後段）。
- judge を retrieval 参照採点に戻す。

完了後 Claude が out/31 を機械検算（top-1 含有率の独立再計算・生成入力対称性・2×2・救済突合）し、検索粒度の採否と次（generation改善 or #08）を数値判断。

関連: out/27 / out/29 / out/30 / `rejudge-out26.py` / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]] / [[local-cpu-edge-infeasible]]
