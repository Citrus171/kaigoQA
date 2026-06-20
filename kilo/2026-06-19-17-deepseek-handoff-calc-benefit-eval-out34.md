# DeepSeek handoff #17: 新calc-benefit 20件を relaxed軸で評価 → out/34

作成 2026-06-19 / Claude → Kilo(DeepSeek)。**handoff #16 のタスク2を独立化した実行用ドキュメント**（タスク1=gold作成・検証・マージはClaude完了済）。

## ゴール
verified方式に統一した新calc-benefit/boundary 20件を、確定済みの **relaxed軸** で cloud q-level RAG 評価し、RAGの真の難所（報酬・算定）を露出させる。easy 92.7% との差分で **retrieval/generation/gold のどこに次投資すべきか** を判断可能にする。

## 🔴 鉄則（[[eval-oracle-asymmetry-pitfall]]）
judge は全ref(gold)・temp=0。生成入力規模は oracle と同オーダー。**real が oracle を超えたら停止して報告**（評価バグのサイン）。judge を retrieval 参照採点に戻さない。

## 入力（確定済み・Claudeマージ済）
- `apps/api/eval/data/routing-gold-a.jsonl`（**135件**。calc-benefit 37・boundary 20）。dev=`routing-gold-a-dev.jsonl`(110) / holdout=`routing-gold-a-holdout.jsonl`(25)。
- 評価対象の新20件 = `id` が **`gold-calc-001`〜`gold-calc-020`**（calc-benefit 18 + boundary 2）。一次確認済・出典付き・referencePoints≥4・`reviewStatus:approved`。
  - ※ `answer` 本文は空。**referencePoints が採点基盤**（relaxed-anchor judge）。
- relaxed採点ロジック = out/33 の anchor精緻化judge（`data/relaxed-anchor-verdicts.json` を出した判定）。039 anchor原則を踏襲。
- 旧hedge版5件(gold-A-063/072/073/079/081)は除去済。バックアップ `routing-gold-a*.jsonl.bak`。

## 事前確認済み（Claude・2026-06-19／詰まり防止）
- **referencePoints に `id` フィールドは不要**。`judge.ts` は `judgePromptWithReference(q, a, points: string[])`＝文字列配列、`gold-tier-judge-2axis.py` も文字列リスト＋**実行時の正規表現で main/supplement を判定**（`classify_tier`、`_manual_supp` は位置index）。**どこも `ref.id` を参照しない**＝フラット文字列配列の新エントリで全件正常に採点される（スキップ・誤判定なし）。
- **tier分布検証済**: 新20件 main=122/supp=1（supp率1%）で既存gold-A calc-benefit(19件: main95/supp1)と同一傾向。calc-benefitは金額・要件=核心ゆえmain偏重が正常（relaxedが実質strictに近いのは難所セットの意図）。**main=0（relaxed採点不能）の質問はゼロ**。
- **既知の落とし穴を1件修正済**: 年号注記「（平成X年〜）」は `平成\d+年` に当たり core fact を supplement へ誤降格させる。calc-016 の類型点数（70/60/40/20＝核心）がこれに該当したため除去済。**新たに gold を編集する際は core point に `平成X年`/`法第X条`/`に施行` 等を含めない**（含めると relaxed 必須から外れる）。

## 手順
1. **embed再計算**: 新20件の referencePoints を corpus に追加 → q-level chunk（1質問=1chunk連結）で再embed（Workers AI `@cf/baai/bge-m3`、**新キャッシュは別ファイル**に出力）。
2. **生成**: cloud(deepseek-v4-flash) を q-level RAG（検索→top-1 src_id の chunk＝oracle同オーダー）で生成。出力 `data/rag-mvp-cloud-calc.jsonl`。
3. **relaxed採点**:
   - 🔴 calc-benefit の線引き: **算定要件・金額・条件は質問の核心**。条文番号と違い、これらの欠落は relaxed でも **bad**（「条件を落としたが大筋合っている」を good にしない＝軸崩壊防止）。
   - factual は特に厳格（誤った金額・要件は hallucination）。
4. **out/34** 作成（下記）。

## 成果物
- 新 embed キャッシュ（qlevel拡張・別ファイル）/ `data/rag-mvp-cloud-calc.jsonl`
- `apps/api/eval/out/34-calc-benefit-eval.md`:
  - 新20件の relaxed good率 と **easy 92.7%（out/33）との差**
  - 失敗の分解: **retrieval failure / reasoning failure / factual誤り** の内訳
  - generation改善の要否判断材料

## やらないこと
- gold の再マージ（済）。算定要件・金額の欠落を relaxed good にすること（核心・軸が壊れる）。
- edge 評価 / generation 改善（out/34 の結果を見て別途）。judge を retrieval 参照採点に戻すこと。

## 完了後（Claude）
out/34 を機械検算（relaxed good率の独立再計算・factual誤りの確認・oracle対称性）→ 初めて全領域込みで「次投資先」を判断。**既存hedge calc-benefit 19件(gold-A-061等)のverified化の優先度も、out/34の実測bad率を見て決める**。

関連: [[poc-work-state-2026-06-19]] / out/33 / `data/relaxed-anchor-verdicts.json` / handoff #16 / [[judge-strictness-usecase-mismatch]] / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]]
