# Today's Work — 2026-06-19

介護QA RAG / selective routing PoC。本日の主軸は「**評価基盤の信頼性を確立する**」こと。アルゴリズム改善より物差しを直し続けた一日。

---

## 概要（一言）

cloud RAG の品質は「数値」より「**その数値が何を意味するか**」を確定させた。retrieval は解決し、最大の律速は gold/judge 設計の厳格さだったと判明。relaxed 92.7%（ただし易しめセット）まで来て、本丸の報酬領域（calc-benefit）検証の手前。

---

## やったこと

### 1. docker build 検証（handoff #07 完了）
- api/web イメージ build 成功・`/health` 200・typecheck 緑。
- 修正: api Dockerfile に `--chown=node:node`（group-only 権限で EACCES）、web next.config を `__dirname` 方式（`import.meta` が CJS 評価で衝突）。

### 2. RAG / selective routing 評価の立て直し（out/26→33）
- **評価軸を確立**: 同一 judge・全 ref（`data/rejudge-out26-verdicts.json`）。過去の非対称比較を全部引き直し。
- **oracle 非対称の罠を3回検出 → 鉄則化**:
  - out/26: judge 参照が oracle=全ref / real=retrieval参照 で非対称
  - out/28: 生成入力が oracle の 14倍（top-20 全 src の親 70件注入）
  - out/31: 生成 run の交絡（oracle=過去run / qlevel=今回run、odd 7件全件 自質問hit）
- **retrieval は解決**: chunk 粒度変更（1ref=1chunk → 1質問=1chunk 連結）で **top-1 gid 65.9% → 95.1%**。k拡大・parent-document・reranker はいずれも無効と確定。
- **最大の律速はモデルでなく gold/judge の厳格さ**: strict 68.3% → relaxed **92.7%**。用途（一次対応・簡潔2-3文）に条文番号は不要＝用途ミスマッチ。
- **relaxed 正規 KPI・strict 副軸を確定**（out/33）。anchor を「**質問が直接求める核心情報の欠落のみ bad**」に精緻化（質問スコープ導入）。

### 3. calc-benefit 拡充（差し戻し中）
- pending gold 20件（calc-benefit 18 + boundary 2）草案を機械検算 → 形式 OK だが**具体値欠落で差し戻し（#17）**。

### 4. git / メモリ
- kaigoQA に push（`a9d77bc`, `a3f1e88`）。embed キャッシュは .gitignore 除外。
- メモリ整備: `judge-strictness-usecase-mismatch` / `eval-oracle-asymmetry-pitfall` / `poc-work-state-2026-06-19` / `selective-routing-pivot`。

---

## 主要な確定事項（数値）

| 項目 | 値 |
|---|---|
| retrieval (top-1 gid 含有率) | 95.1%（chunk粒度変更後） |
| cloud relaxed good（正規KPI） | **92.7%**（38/41、ただし易しめセット） |
| cloud strict good（副軸・全要点網羅率） | 31.7% |
| relaxed bad 3件 | 039(核心欠落) / 038・042(真retrieval) |
| 真の retrieval failure | 2件（4.9%） |

判定の事実上の仕様（judgeゴールデンテスト候補）: **037=good / 060=good / 039=bad / 038=bad**。

---

## 次やること（優先順）

1. **calc-benefit gold の数値確定**（← いまここ。ユーザーが手動で報酬数値・出典を調査中）。
2. #17 差し戻し対応: 曖昧表現を 2024年度改定の具体値＋出典で埋め直し。**同時に各 ref へ `tier: main/supplement` を付与**（下記「改善」参照）。
3. Claude 機械検算（数値の桁/単位・出典の有無）→ **ユーザーが数値の正誤を最終承認** → マージ。
4. **out/34**: calc-benefit を relaxed 軸で評価。92.7% が本物か、報酬領域で落ちるか。
5. ここで初めて **retrieval / generation / gold のどこに次投資するか**を全領域込みで判断。

### out/34 の解釈枠組み（採用）
- **ケースA（92.7%→88-92%）**: RAG は強い。generation 改善の優先度低。
- **ケースB（→70-80%）**: 律速は数値抽出・条件抽出・長文要件整理。reranker / structured retrieval / answer planner を検討。
- **ケースC（→50-60%）**: 評価セットが易しかっただけ＝**代表性不足**が真因（generation 改善ではない）。
- ※落ち幅だけでなく「落ちた件の失敗種別（数値抽出/条件抽出/factual誤り）」まで分解して A/B/C を判定する。

---

## ペンディング / 保留

- **#17 の tier化追記・judgeゴールデンテスト導入**は、ユーザーの数値調査が戻ってから再開（本日合意済みだが未着手）。
- gold tier(main/supplement) 分離は handoff #15 タスク1 で未達のまま。calc-benefit 再提出で回収予定。

---

## 改善できそうなこと（プロセス）

1. **gold tier 化を calc-benefit と同時に済ませる**（懸念の予見）。calc-benefit は「報酬数値（main）」と「告示番号・条番号（supplement）」が1質問に混在し、tier 無しだと judge が報酬領域で再び不安定化（037/038 の anchor 過剰適用が再発）。tier 明示で relaxed=main網羅・supplement不問を機械化できる。
2. **judge ゴールデンテストの導入（最優先）**。今日の判断（037 good / 060 good / 039 bad / 038 bad）をコード化し、judge 変更時に必ず回す。今回起きた overreach 全件 true・anchor 過剰適用・038 誤 good を即検知できる。評価基盤は一度壊れると過去比較が全部怪しくなるので回収率が高い。
3. **Kilo の handoff 着手時に「oracle 条件対称性チェック」を必須化**。judge 参照・生成入力・生成 run の3点を揃えたか確認しないと oracle 非対称の罠（今日3回）が再発する。
4. **gold 作成の入口管理**: 「質問が問う核心要素を必ず main ref に含む」を要件化（今回は差し戻しで対処したが handoff 段階で防ぎたい）。
5. **新しい評価を始める前にカテゴリ分布を確認**。calc-benefit 0件に終盤まで気づかず「92.7% は易しめ」の認識が遅れた。

---

## 一言

本日の本質的成果は数値（92.7%）ではなく、**4種類の評価バイアス（judge非対称 / 生成条件非対称 / retrieval錯覚 / gold-judge厳格さ）を順に潰し、KPI 定義を確立したこと**。これにより次の calc-benefit 評価が初めて意味を持つ。
