# DeepSeek handoff: Dataset A 拡充（#2 / 評価ラインの統計的足場）

作成 2026-06-18 / Claude → Kilo(DeepSeek)。
**タスク**: `apps/api/eval/data/routing-gold-a.jsonl`（現120件）に**新規クエリを追加**し、評価母数を増やす。
理由: 現状すべて n=41(edge候補) で測っており、post-hoc capture 33% も**過学習の楽観値**。
retrieval評価(#1)・badケース分析(#3)・交差検証(#4)の信頼性は母数に依存する。**評価ラインと並行で回せる純生成作業**なので委譲。

## 目標（第一弾）

- **+60件**を新規生成。内訳の重点:
  - **expected=edge を +40**（現41→約81。edge候補の評価母数を約2倍に＝最優先）
  - expected=cloud を +20（現79→約99）
  - 薄い category を補強: **boundary-case(現18)・service-compare(現18)** を厚めに。calc-benefit も歓迎（算定はTool route検証に効く）
- id は `gold-A-121` から連番。

## スキーマ（既存と完全一致・1件例）

既存 `routing-gold-a.jsonl` の1行と同じフィールド構成にする:
```json
{"id":"gold-A-121","query":"<利用者目線の自然な質問>","expected":"edge|cloud",
 "category":"system-explain|procedure|calc-benefit|service-compare|boundary-case",
 "referencePoints":["<採点根拠になる介護保険の事実1>","<事実2>"],
 "answer":"<2〜3文の模範回答>","answerSource":"deepseek-draft",
 "answerReview":"pending","reviewStatus":"pending","borderline":false,
 "note":"","provenance":"<根拠の出典メモ：厚労省◯◯Q&A 等>"}
```
- **`answerReview`/`reviewStatus` は必ず `pending`** で出す（承認は人間／Claude。勝手に approved にしない）。
- `referencePoints` は**検証可能な事実**のみ（制度名・単位数・区分・年など）。曖昧な一般論は不可。数値は出典必須。

## expected ラベルの付与基準（重要な注記）

- 付与ヒューリスティック: **一般的な制度説明・単純手続き → edge** / **施設固有情報・複雑算定・複数制度横断・例外判断 → cloud**。
- ⚠ out/25 で **expected ラベルは実 good率を予測しない**と判明済み（[[selective-routing-pivot]]）。
  よって expected は「**評価サブセットの分割ラベル**」であって品質保証ではない。深く悩まず上記基準で機械的に付ければよい。

## 品質ガード（必須）

1. **重複回避**: 新規クエリを bge-m3 で embed し、既存120件との **max cosine > 0.92 は意味重複として除外**して作り直す。
   - CPU embed は遅い（bge-m3 ≈5秒/件 [[local-cpu-edge-infeasible]]）。**#1 のRAG embed と同時刻にぶつけない**（CPU競合）。
2. **多様性**: 同一論点の言い換え量産をしない。論点（給付/認定/区分支給限度/加算/サービス種別/権利擁護 等）を散らす。
3. **answer は EDGE 想定の長さ**（2〜3文）。referencePoints は採点が機能する粒度（1点=1事実）。

## 出力（承認前なので data/ には直接マージしない）

- `kilo/2026-06-18-08-dataset-a-expansion-draft.jsonl`（+60件ドラフト・全 pending）
- `kilo/2026-06-18-08-dataset-a-expansion-sources.md`（各件の referencePoints 出典メモ一覧）
- ⚠ `apps/api/eval/data/routing-gold-a.jsonl` への追記は**しない**。承認後に Claude/ユーザーがマージする。

## 承認フロー（この後）

1. Kilo: ドラフト生成（pending）。
2. **Claude: 機械検算**（スキーマ妥当性・id重複・JSON妥当・数値の出典有無・bge-m3重複チェック再走）。
3. **ユーザー: 承認**（expected と referencePoints を確認 = レベル2 Human Approval。最も価値の高い工程）。
4. 承認分のみ `answerReview:"approved"` にして `routing-gold-a.jsonl` へマージ。

関連: [[selective-routing-pivot]] / [[deepseek-handoff-default]] / handoff `06`(RAG MVP) と並行可
