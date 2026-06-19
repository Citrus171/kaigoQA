# DeepSeek handoff: calc-benefit/boundary を20件追加し relaxed軸で評価（out/34）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: 評価セットに欠けている **calc-benefit（報酬・算定・加算）/ boundary-case（境界事例）を20件追加**し、確定済みの relaxed 軸で cloud q-level RAG を評価する。RAGの「真の難所」を露出させる。

> ## 🔴 鉄則（[[eval-oracle-asymmetry-pitfall]]）
> judge は全ref(gold)・temp=0。生成入力規模は oracle と同オーダー。real が oracle を超えたら停止報告。

## 確定済み素材（これを使う）
- `data/pending-gold-calc-benefit.jsonl`（20件・referencePoints入りの草案／reviewStatus:pending）。
- `data/calc-benefit-provisional-values.md`（Claude暫定値＋自信度）。
- `data/calc-benefit-verification-sources.md`（**出典URL付き照合結果**。calc-002/004/006/008/012/015/017 を確認済）。
- **calc-012 はClaude一次確認済**（加算率 I:20/II:10/III:10/IV:3/V:3、人材要件=介護福祉士30%以上 or 介護福祉士等50%以上の選択要件・I/II共通、60%要件は無し）。pendingに反映済。残り19件はユーザー承認待ち。

## 背景（ここまで確定）
- cloud q-level RAG の relaxed good = **92.7%**（out/33, [[judge-strictness-usecase-mismatch]]）。**ただし edge候補41件は system-explain/service-compare 中心で calc-benefit 0件＝易しめセット**。
- RAGの真の難所は報酬・算定（加算条件・算定要件・限度額・例外）。ここを入れないと 92.7% は楽観値。

## ✅ タスク1は完了済み（Claude実行・2026-06-19）
- 20件のgold（calc-benefit 18 + boundary 2）を一次確認・ユーザー承認・**routing-gold-a へマージ済**。
- **重要な再発見**: gold-a には既に calc-benefit が24件あった（「0件」前提は誤り）。話題重複5件(gold-A-063/072/073/079/081)を**新検証版で置換**し、新20件を追加 → gold-a **120→135件**（calc-benefit 24→37・boundary 18→20）。dev(110)/holdout(25)も整合再構築済。バックアップ `*.jsonl.bak`。
- **方式決定（ユーザー承認）**: calc-benefit goldは「数値・前提を断定せず要確認で逃げるhedge方式」をやめ、**一次確認した具体値＋出典を明記するverified方式に統一**（relaxed軸=算定要件・金額・条件は核心、に整合）。
- ⚠️ **残課題**: 既存の非重複calc-benefit 19件(gold-A-061等)はまだhedge方式＝順次verified化（一次確認）が必要。新20件の `answer` 本文は空（referencePointsが採点基盤。必要なら参照答案を別途生成）。
- → **DeepSeekの担当はタスク2（embed再計算＋relaxed評価＋out/34）から**。以下タスク1は記録として残置。

## タスク1（実行記録）: gold 20件作成（calc-benefit 15 + boundary-case 5 目安）
- 質問は利用者/家族が一次対応で聞く形（例: 高額介護サービス費の自己負担上限、区分支給限度基準額を超えた場合、個別機能訓練加算/入浴介助加算の算定要件、生活援助の算定回数・同居家族がいる場合、処遇改善加算、boundary=「介護」と日常の「手助け」の境目 等）。
- `expected="cloud"`（calc-benefit は edge では無理＝cloud escalate前提。edge はスコープ外）。
- **各質問に referencePoints を作成**。利用者の意思決定に直結する**核心(算定要件・金額・条件)**と、条文番号・告示番号等の**補足**を区別して書く。
- 🔴 **正確性が最重要**: 報酬・算定は誤りやすい。**各 referencePoint に出典（介護報酬単位数表・厚労省告示・介護報酬Q&A の該当箇所）を必ず併記**し検証可能に。年度（2024年度改定）を明記。

### 承認フロー（[[deepseek-handoff-default]]：gold は人間依存）
1. Kilo が **pending jsonl** で草案（質問＋referencePoints＋出典）を出す。
2. Claude が機械検算（形式・id重複・referencePoints数・出典の有無）。
3. **ユーザー（ドメイン承認者）が報酬数値・算定要件の正確性を承認**（ここが学習も兼ねる）。
4. 承認後に `routing-gold-a.jsonl` へマージ。**未承認のままマージ・評価しない**。

## タスク2: relaxed軸で評価（承認後）
- corpus に新20件の referencePoints を追加 → **q-level chunk（1質問=1chunk連結）で embed 再計算**（Workers AI `@cf/baai/bge-m3`、新キャッシュ別ファイル）。
- cloud(deepseek-v4-flash) を q-level RAG（検索→top-1 src_id の chunk＝oracle同オーダー）で生成。
- **relaxed採点**: out/33 の anchor精緻化judge（`data/relaxed-anchor-verdicts.json` を出した判定ロジック）を使う。
  - 🔴 calc-benefit での relaxed の線引き: **算定要件・金額・条件は質問の核心**。条文番号と違い、これらの欠落は relaxed でも bad（「算定条件を落としたが大筋合っている」は good にしない＝将来の軸崩壊を防ぐ）。
  - factual は特に厳格（誤った金額・要件は hallucination）。
- 新20件の relaxed good率を算出し、**既存 easy 92.7% と対比**。

## 成果物
- pending gold（承認用）→ 承認後マージ版
- 新 embed キャッシュ（qlevel拡張）/ `data/rag-mvp-cloud-calc.jsonl`
- `apps/api/eval/out/34-calc-benefit-eval.md`: 追加20件の内訳 / relaxed good率 / easy 92.7%との差 / retrieval failure・reasoning failure・factual誤りの分解 / generation改善の要否判断材料

## やらないこと
- gold 未承認でのマージ・評価。
- 算定要件・金額の欠落を relaxed good にすること（核心。軸が壊れる）。
- 出典なしの referencePoint。
- edge 評価 / generation 改善（out/34 の結果を見て別途）。
- judge を retrieval 参照採点に戻す。

完了後 Claude が out/34 を機械検算（relaxed good率の独立再計算・factual誤りの確認・oracle対称性）→ ここで初めて **「retrieval/generation/gold のどこに次投資すべきか」を全領域込みで判断**できる。

関連: out/33 / `data/relaxed-anchor-verdicts.json` / [[judge-strictness-usecase-mismatch]] / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]] / [[poc-work-state-2026-06-19]]
