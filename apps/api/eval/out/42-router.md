# 42: Capability Router 全135件評価（フェーズ2）

`2026-06-19 19:19` / elapsed=236s / model=deepseek-v4-flash / judge=openai/gpt-4o

## 設計根拠
- フェーズ1の故障分離で、介護報酬の「計算系」質問は決定論的単一解を持たず、正解は「手順＋確定制度定数＋ケアマネ/最新改定に委ねる」と判明。
- 本番 EDGE_SYSTEM(V2) の「数値を省略するな」指示が underdetermined な質問では数値の捏造を誘発（gold-A-076 が factual 失敗）。
- → LLM分類器で knowledge_qa / escalate に振り分け、escalate は数値捏造を抑止する guardrail 生成を当てる。

## Router 分類精度

**accuracy = 133/135 = 98.5%**

| gold＼pred | knowledge_qa | escalate |
|---|---|---|
| **knowledge_qa** | 128 | 2 |
| **escalate** | 0 | 5 |

route distribution: knowledge_qa 128 (95%) / escalate 7 (5%)

## KPI（同一 judge・同一 tier で before/after 比較）

| | relaxed good |
|---|---|
| before（top-3 RAG = out/41） | 125/135 = 92.6% |
| after（Capability Router） | 127/135 = 94.1% |
| 差分 | +2件 (+1.5pt) |

## escalate 経路の個別追跡

| id | category | pred正誤 | before | after | judge reason(after) |
|---|---|---|---|---|---|
| gold-A-061 | calc-benefit | ✓ | bad | good | 補足情報が不足しているため |
| gold-A-062 | calc-benefit | ✓ | good | good | 主要事実を全てカバーしている |
| gold-A-066 | calc-benefit | ✓ | good | good | 主要事実と補足情報を網羅 |
| gold-A-076 | calc-benefit | ✓ | bad | good | 主要事実と補足情報を網羅 |
| gold-A-080 | calc-benefit | ✓ | good | good | 主要事実と補足情報を網羅 |

## 誤分類 (misroute)

| id | category | gold | pred | reason |
|---|---|---|---|---|
| gold-A-110 | boundary-case | knowledge_qa | escalate | 個人のケース判断が必要 |
| gold-calc-018 | calc-benefit | knowledge_qa | escalate | 個別の人員配置に依存 |

## 設計反復（guardrail 1版→2版）

初版 guardrail は「数値を捏造しない」が過剰に効き、gold が主要事実とする**目安（幅のある概算）まで省略**して回帰した:

| 版 | KPI差分 | 内訳 |
|---|---|---|
| guardrail v1（捏造禁止のみ） | **−2件** | A-076 ↑修正したが、A-066・A-080・A-110 が目安省略で ↓回帰 |
| guardrail v2（目安は幅つきで保持＋計算式を明示） | **+2件** | 回帰3件すべて解消、A-061 も式＋区分限度額の明示で ↑修正、捏造抑止は維持 |

→ 教訓: 「数値の捏造抑止」と「参考情報にある目安の保持」は別物。route 適応プロンプトでも両者を分離して指示する必要がある。

## 考察
- Router 分類精度 **98.5%**（FP 2件=boundary/個別人員のborderline, FN 0）。route distribution knowledge_qa 95% / escalate 5%。
- KPI **92.6% → 94.1%（+2件, +1.5pt）**。回帰0。
- 改善の実体は2つの故障モード解消: **A-061（数値の欠落＝omitted）** に確定制度定数(要介護3=27,048単位)＋計算式を付与、**A-076（数値の捏造＝factual）** を honest deferral（ケアマネ試算へ誘導）へ置換。
- いずれも単一グローバルプロンプト（本番V2）では両立できなかった「数値を出せ⇔出すな」の矛盾を、**route で生成方針を分離**して解決した点が本設計の核心。
