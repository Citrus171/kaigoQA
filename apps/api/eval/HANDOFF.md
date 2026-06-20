# HANDOFF: Stage2 品質検証ローカル分析

宛先: 別エージェント（Kilo Code + DeepSeek V4 Pro）
作成: 2026-06-17 / 作成元: Claude Code セッション
目的: GPU full E2E の本丸を待つ間に、**ローカル完結で片付くタスク①〜③を先行完了**しておく。

---

## 0. 大前提（必ず守る）

- **GPU / RunPod / wrangler / デプロイは一切触らない。** それらが律速の作業は人間が戻ってから手動でやる。
- このタスクは `apps/api/eval/` 配下のコードと `apps/api/eval/data/` 配下の JSONL **だけ**で完結する。
- 新しい本番コードは書かない。**分析・集計・ドラフト文書の作成**が仕事。
- 数値を**でっち上げない**。集計は実データから機械的に出す。読めない・足りない時は「不明」と書いて止め、人間に確認を残す。
- 成果物は `apps/api/eval/out/` に**新規ファイル**として置き、コミットする（戻ったときにマージ・レビューする前提）。既存の追跡ファイルは書き換えない。

---

## 1. 背景コンテキスト（行間を補完しない・ここが全前提）

AIルーティングPoC の Stage2 = 「edge(ローカルSLM) にオフロードしても品質が維持できるか」を**自己採点バイアス無し**で検証するフェーズ。

確定済みの事実（再検証不要、これを土台にする）:
- routed ポリシーは cloud 比で **latency p50 −55%**（GPU full E2E で実測済み）。これは latency 側の結論。
- 旧 e2e の cloud 採点は「生成 cloud = 採点 judge が同一 deepseek」＝**自己採点バイアス**があった。そこで生成を1回固定し judge を別系統に差し替える `rejudge.ts` を導入済み。
- **参照採点（referencePoints を judge に渡す）はノイズ床ではなく精度是正**、と直近で実証した（コミット b551550）。
- judge のノイズ床は「同一回答を K 回採点して good/bad 判定が揺れる割合 = flip率」で定量化する（`rejudge.ts --repeat K`）。

**flip JSONL 3本の素性（重要: 単純横並び不可。judge も条件も違う）:**
| ファイル | judge | 条件 | 行数 |
|---|---|---|---|
| `data/flip-judge-openai-gpt-4o-k5-e2e-ollama-gemma3-4b.jsonl` | GPT-4o | K=5 | 14 |
| `data/flip-judge-deepseek-deepseek-v4-flash-k5-e2e-ollama-gemma3-4b.jsonl` | deepseek-v4-flash | K=5・**rubric改定後(★後)** | 16 |
| `data/flip-v4flash-PRE-rubric.jsonl` | deepseek-v4-flash | **rubric改定前(★前)** | 16 |

- 3本は judge / rubric が異なるため、全体を1つの表に並べて「優劣」を語ってはいけない。**比較してよい軸を限定する**こと（同一judgeの★前 vs ★後、または同一条件での off vs on）。
- cloud 充填データは OpenRouter 経由で生成されたもの（直APIではない）。
- これら3本は**既に flip率モードの出力**＝集計済み（各レコードに `off`/`on`、その中に `flipped`/`majorityGood` が入っている）。**API を叩き直す必要はない。読むだけ。**

---

## 2. 該当ファイル（絶対パス）

- ハーネス: `apps/api/eval/rejudge.ts`（独立judge再採点 + Phase E flip率モード）
- judge本体: `apps/api/eval/judge.ts`（`judgeAnswer` / `isGoodAnswer` / 参照採点プロンプト）
- gold/参照ローダ: `apps/api/eval/data/load.ts`（`loadGold` / `referencePointsOf` = 承認ゲート）
- gold データ: `apps/api/eval/data/routing-gold.jsonl`（35行。フィールド: id, query, expected, category, answerSource, provenance, reviewStatus, borderline, referencePoints, answer, **answerReview**）
- flip 生データ3本: 上表参照（`apps/api/eval/data/` 配下）

注意: `routing-gold.jsonl` の `reviewStatus` は34件すべて `pending`。**承認の真実は `answerReview` フィールド**であり、判定は `referencePointsOf()`（`load.ts`）が一元管理する。「承認済み参照を持つ項目数」を知りたければ、`reviewStatus` を数えず `referencePointsOf` が値を返す件数を数えること（flip対象になった 14〜16 件がその実数の目安）。

---

## 3. タスク（①→②→③の順。④は保留）

### ① flip率分析の完成 ＝ 完全オフライン（API不要）

入力: flip JSONL 3本（上表）。各行は `{id, side, query, off, on}`。`off`/`on` は `{verdicts[], goods[], flipped, majorityGood}`。

手順:
1. 3本を読み込み、本ごとに次を集計する: 件数 n / `off.flipped` 件数と率 / `on.flipped` 件数と率 / `off.majorityGood`・`on.majorityGood` 率。
2. **比較してよい軸だけ**で表を作る:
   - (A) 同一judge(v4flash)の **★前 vs ★後**（rubric改定の効果）。
   - (B) 各本内の **参照なし(off) vs 参照あり(on)** の flip率差（参照採点のノイズ床削減効果）。
   - GPT-4o と deepseek は judge が違うので「good率の優劣」は語らない。flip率の**傾向**比較にとどめる。
3. flip した項目（`off.flipped || on.flipped`）を id/side/query 付きで列挙する。

期待出力: `apps/api/eval/out/01-flip-analysis.md`（上記の表 + flip項目一覧 + 1段落の所見）。
成功条件: 3本それぞれに n・off/on flip率・majorityGood率が数値で埋まり、(A)(B)の比較表があり、judge差を優劣として誤読していないこと。

### ② Stage2 結論ドラフト作成（①の数値を読んで下書き、最終判断は人間）

判定基準（この4項目に①と既知数値を当てはめる）:
- latency 改善 > 40%（既知: routed p50 −55% → 充足）
- offload率（routed が edge を選んだ割合。GPU E2E 出力が要るので、無ければ「GPU結果待ち」と明記）
- 品質 loss < 5%（独立judge good率で routed vs always-cloud を比較。数値が無ければ「GPU結果待ち」）
- judge ノイズ床（①の flip率。参照採点で下がっているか）

手順: 上記4項目を表にし、現時点で埋まる数値を入れ、空欄は「GPU full E2E 出力待ち（人間が戻ってから差し込む）」と明記。最後に「現状で言える結論」と「未確定で人間判断が要る点」を分ける。

期待出力: `apps/api/eval/out/02-stage2-conclusion-draft.md`。
成功条件: 4基準すべてに「数値 or 待ち理由」が入り、確定/未確定が分離され、**断定を人間レビュー前提のドラフトと明記**していること。

### ③ edge比較の物差し準備（コード読解 + テンプレ化、実行は人間が戻ってから）

目的: 参照gold採点を「④ edge(gemma3:4b) 比較」に流用できるよう、入出力とコマンドをテンプレ化する。

手順:
1. `rejudge.ts` の flip率モード（`--repeat K`、`runFlipMode`）と単発再採点モードの**実行コマンド・必要env・入出力パス命名規則**を読み取り、手順書化する。
   - 実行例: `OPENROUTER_API_KEY=... npm run eval:rejudge -w @hybrid/api -- <input.jsonl> --repeat 5`
   - flip率モードは温度非0必須（未設定なら K≥2 で自動 0.7）。出力は `data/flip-<judgeSlug>-k<K>-<input名>`。
2. edge候補モデルの E2E 出力を入力にしたとき、どの env / 入力ファイル名を差し替えれば回るかを**穴埋めテンプレ**にする（実行はしない）。
3. `judge.ts` の参照採点プロンプトが何を渡しているか要約する。

期待出力: `apps/api/eval/out/03-edge-eval-runbook.md`（コマンドテンプレ + env一覧 + 入出力命名 + 注意点）。
成功条件: 人間がモデル名と入力パスを埋めるだけで実行できる手順書になっていること。**実際の judge API は叩かない。**

### ④ edge SLM候補調査 ＝ **保留（人間が戻ってから判断）**

理由: Granite(Apache)/Gemma3(Gemma規約) の実品質比較は外部API課金（OpenRouter or Ollamaローカル起動）が絡み、鍵は Kilo 側環境で手動管理が必要。①〜③が終わって余力があれば、**ライセンス整理（商用可否の表）だけ**を `out/04-edge-slm-license-notes.md` にまとめてよい（API試打はしない）。

---

## 4. やらないこと（再掲）

- GPU / RunPod / wrangler / デプロイ。
- 本番コードの変更、既存追跡ファイル（gold/flip JSONL等）の書き換え。
- judge API の実呼び出し（①は不要、③④は人間が戻ってから）。
- judge が違うデータ同士の good率優劣の断定。

## 5. 成果物の受け渡し

- 出力は全部 `apps/api/eval/out/` に新規 .md で置く。
- 終わったら `git add apps/api/eval/out/ && git commit`（ブランチは現行のまま）。コミットメッセージに「どの数値が確定/未確定か」を1行残す。
- 人間が戻ったら ②を読み、GPU E2E の数値を差し込んで結論を確定 → ③のrunbookで④を実行、という順で再開する。
