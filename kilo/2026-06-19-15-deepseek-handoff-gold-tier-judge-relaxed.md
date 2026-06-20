# DeepSeek handoff: gold を main/supplement 分離 + judge を relaxed/strict 2軸化（out/33）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: 評価軸を relaxed（正規）/ strict（副軸）に確定する。gold の referencePoints を main/supplement に分離し、judge を2フラグ出力に改定して real 41件を再採点する。

> ## 🔴 鉄則（[[eval-oracle-asymmetry-pitfall]]）
> judge は全ref(gold)・temp=0 固定。oracle と real の比較条件（生成run・生成入力・judge基準）を揃える。real が oracle を超えたら停止報告。

## 確定した評価軸（[[judge-strictness-usecase-mismatch]] / ユーザー承認済み）
システム用途＝「介護施設の一次対応アシスタント・簡潔に2-3文」。これに整合する軸：
- **relaxed（正規KPI）**: 利用者が**次に取るべき行動・理解すべき主要事実**を得られれば good。法令の条番号・条文引用・年号・限度額等の**補足細目の欠落は許容**。
- **strict（副軸・参考併記）**: gold の**全要点**（条文・数値・例外・補足含む）を網羅して good。
- factual / overreach は両軸とも厳格維持（ハルシネーション・過剰断定は拾う）。

### 確定値（手レビュー済み・期待値）
- strict good = 28/41 = 68.3% / **relaxed good = 38/41 = 92.7%**。
- relaxed で bad維持の3件: **gold-A-039**（更新中の継続利用可否＝核心情報の欠落）, gold-A-038・042（真の retrieval failure）。
- relaxed で good 転換の10件（条文/付随/境界の欠落のみ）: 001,010,026,032,033,037,040,085,091,098。

## anchor case（039）の埋め込み方 — リーク回避が必須
**039 の答案を逐語で few-shot に貼らない**（過学習・self-reference リーク）。代わりに judge プロンプトに**原則＋抽象例**を書く:

> 「質問の核心＝**利用者の意思決定に直結する主要事実（帰結情報）**の欠落は、条文番号・細目の欠落と違い relaxed でも insufficient とする。例：更新手続きで『結果が間に合わない場合の継続利用可否・認定が切れた時のリスク』のような帰結情報を落とした場合。」

こうすれば 039 が正しく bad になり、かつ将来 calc-benefit 領域の「算定条件を落としたが大筋合っている」回答にも汎化する（＝将来の評価軸を守る）。

## 手順
1. **gold 再タグ付け**: 各 referencePoint に `tier: "main" | "supplement"` を付与（edge候補41件分、できれば全120件）。
   - supplement = 法令条番号・条文引用・年号・限度額・「市区町村により異なるため要確認」等の補足。
   - main = 利用者の行動・理解・意思決定に直結する事実。
   - **ドメイン判断なので Kilo は草案を作り、Claude が検算 → ユーザーが最終承認**（[[deepseek-handoff-default]]：gold は人間依存）。pending一覧で出す。
2. **judge 改定**: 1回の呼び出しで `sufficient_relaxed`（main をカバー＋核心情報欠落なし）と `sufficient_strict`（main+supplement 全網羅）の2フラグ＋`factual`/`overreach`/`category`/`reason` を出力。上記 anchor 原則を明記。
3. **real 41件 再採点**（q-level answer 据え置き、gold全ref提示）: relaxed/strict good率を算出。**relaxed=92.7%（039 bad維持）を再現できるか検証**。ズレたら原因報告。
4. レポートに relaxed（KPI）と strict（参考）を併記。

## oracle 側の扱い（注意）
- 現状 oracle 答案が保存されていない（`oracle-rebaseline.py` は verdict のみ）。oracle を2フラグ軸で出すには oracle 再生成（answer 保存）が要る → **本 handoff では real 側の relaxed/strict 確定までが範囲**。cloud good 真値 = relaxed 92.7%（real基準）。oracle 天井の2軸化は必要になったら別途（oracle-rebaseline.py に answer 保存を追加して再生成）。

## 成果物
- gold 再タグ付け版（`tier` 付き。pending → 承認後マージ）
- judge 2フラグ版スクリプト
- `data/rag-mvp-cloud-qlevel-2axis.jsonl`（relaxed/strict verdict）
- `apps/api/eval/out/33-relaxed-strict-axis.md`: tier分離方針 / judge改定 / real再採点の relaxed・strict good率 / 039がbad維持されたか / 考察

## やらないこと
- 039 答案の逐語 few-shot 埋め込み（リーク）。
- 核心情報欠落まで relaxed good にすること（軸が壊れる）。
- calc-benefit 追加（本 handoff 完了・92.7%ベースライン確定後に別 handoff）。
- judge を retrieval 参照採点に戻す。

完了後 Claude が out/33 を機械検算（tier分離の妥当性・relaxed=92.7%再現・039 bad維持・2フラグの整合）→ ユーザー承認 → calc-benefit 20件追加 handoff へ。

関連: out/31 / out/32 / [[judge-strictness-usecase-mismatch]] / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]] / [[poc-work-state-2026-06-19]]
