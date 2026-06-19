# DeepSeek handoff: cloud retrieval failure を削るチャンク設計見直し（out/28）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: cloud の retrieval failure（8/41=19.5%）を、チャンク設計（referencePoint の結合・階層化）で削る。

> 前提（必ず読む）: `out/27-retrieval-coverage.md`（k掃引）, `out/26`(再測定), memory `selective-routing-pivot`。
> 2026-06-19 までに確定したこと:
> - judge は **常に全 referencePoints(gold) で採点**（out/26 で確定した唯一正しい軸。retrieval 参照採点に戻さない）。
> - full-coverage@k は k16-30 で 19.5%→22.0% と**頭打ち**＝chunk1点粒度では全要点を揃えるのに構造限界（同一srcのchunkがcosineで離散、他srcに top-k を奪われる）。
> - cloud: oracle good 61.0% / real(k=20) 46.3%。差 −14.6pt のうち **retrieval failure=8件(19.5%)** が検索網羅性律速で、ここがチャンク設計で削れる対象。reasoning failure 34.1% はチャンク設計では削れない（generation 課題・別タスク）。
> - **edge はスコープ外**（reasoning failure 65.9% 律速で retrieval改善の効きが悪い。現状維持＝安価に拾えるものを拾い、ダメなら cloud）。

## 改善対象（cloud retrieval failure 8件・確定済）
`gold-A-006, 013, 014, 027, 030, 038, 039, 042`
（= oracle good ∩ real(k=20) bad。oracleでは全ref注入で解けたが、retrievalでは要点が揃わず bad になった件）

→ まず**この8件の referencePoints 構成と、現 retrieval(k=20) で何がこぼれたか**を `rejudge-out26-verdicts.json` / `rag-mvp-cloud-k20.jsonl` / `retrieval-coverage.py` の coverage 計算で個別に診断すること。full-coverage が低い件か、特定 referencePoint が一貫して引けない件かで打ち手が変わる。

## アプローチ（A/B比較。最有力は C）
- **A. 質問単位結合**: 1質問の全 referencePoints を1 chunk に結合（M_i個→1）。full-coverage 問題は消えるが、chunk が長く embed が粗くなり別質問との分離が落ちる（recall 低下リスク）。
- **B. 意味的グルーピング**: 近い referencePoint を中間粒度でまとめる。粒度調整が要る。
- **C. 親子（parent-document retrieval）**: 検索は細chunk（現状の1点粒度）、**生成に渡すのは親（質問単位の全referencePoints）**。検索精度を保ちつつ生成側に全要点を渡せる定石。full-coverage 頭打ちを構造的に回避。→ **まず C を本命に試す**。

## 手順
1. **診断**: 上記8件の coverage/full-coverage と、こぼれた referencePoint を特定（生成不要・安い）。
2. **chunk構成を実装**（C本命、必要ならA/Bも）。corpus 構成が変わるので **embed 再計算が必要**（現 `rag-corpus-embeddings.json` は573 chunk固定で無効化）。bge-m3 ollama・CPU。C なら検索用chunkは現状と同じ573なので**embed cache 流用可**（親文書は検索しないので再embed不要）。A/B は再embed要（CPU、chunk数次第で~数分〜19分）。
3. **coverage 再測定**（`retrieval-coverage.py` の phase1 流用・corpus差し替え）。full-coverage が上がるか。
4. **cloud 再生成**: 新構成で cloud(deepseek-v4-flash) を生成（生成に渡す参照=新chunk設計の出力）。k は out/27 と揃えて k=20、または C の親文書渡し。
5. **全ref judge で採点**（`rejudge-out26.py`/`retrieval-coverage.py` の judge() 流用・temp=0・gold全ref）。
6. **2×2 再計算**: oracle(`rejudge-out26-verdicts.json` の oracle_cloud) vs 新real。retrieval failure 8件のうち何件救えたかを明示。

## 目標と上界（正確に）
- KPI = **cloud retrieval failure 8件の削減数**（→ cloud real good の上昇）。
- **実質上界 = oracle good 61.0%**（retrieval failure 全救済でも到達するのはここ）。out/27 の「65.8%」は odd 2件（oracle bad だが retrieval で偶然解けた・再現性低）込みの楽観値なので KPI には使わない。
- full-coverage 頭打ちが示す通り **8件全救済は楽観**。半分でも削れれば cloud real は ~50%台に乗り、selective routing の cloud 側価値が上がる。

## 成果物
- 新 chunk 構成の実装（`retrieval-coverage.py` 拡張 or 新スクリプト）
- `data/rag-mvp-cloud-chunk{方式}.jsonl`（再生成結果）
- `apps/api/eval/out/28-cloud-chunk-design.md`: 8件診断 / 採用方式 / coverage改善 / 2×2 / retrieval failure 削減数 / 考察

## やらないこと
- edge の再生成・edge向けチャンク最適化（reasoning律速でスコープ外）。
- generation 改善（プロンプト/モデル）。retrieval を先に固めてから別 handoff（順序: retrievalを変えると generation 評価も変わるため、後回しにすると二度手間）。
- judge を retrieval 参照採点に戻すこと（汚染の元）。
- #08 Dataset 拡充は本タスク完了後（チャンク設計変更後の評価系で n を増やす方が効率的）。

完了後 Claude が out/28 を機械検算（coverage・2×2・8件の救済突合）し、次（generation改善 or #08）を数値判断。

関連: out/26 / out/27 / `rejudge-out26.py` / `retrieval-coverage.py` / [[selective-routing-pivot]] / [[edge-quality-ceiling-gemma3]] / [[local-cpu-edge-infeasible]]
