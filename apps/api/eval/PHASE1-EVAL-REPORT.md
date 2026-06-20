# 介護保険QA RAG — 評価パイプライン構築レポート（フェーズ1）

介護保険の一次対応QAを対象に、**RAGシステムの品質を測り、故障を切り分け、設計判断を駆動する評価基盤**を構築した記録。
本レポートはフェーズ1（評価の完遂）の確定結果。すべての数値は再現可能な eval スクリプト（`out/33`〜`out/41`）の実測値。

## 1. 課題設定

介護保険の制度・算定・手続きに関する質問へ、LLM が一次対応する。問題は「正しく答えられるか」だけでなく、
**どこで・なぜ失敗するか（検索不足か、生成不足か、知識の天井か）を分離できないと、改善の打ち手が定まらない**点にある。
そこで MVP の精度追求より先に、**故障を切り分けられる評価パイプライン**を設計した。

## 2. 構築したもの

| 構成要素 | 内容 |
|---|---|
| 評価データセット（Dataset A） | 介護保険QA **135件**。5カテゴリ（service-compare / system-explain / calc-benefit / boundary-case / procedure）。各設問に gold answer と **referencePoints（採点根拠の要点）** を付与 |
| Gold tier 設計 | 要点を **main（核心）/ supplement（補足）** に階層化。「質問が直接尋ねる核心の欠落のみを bad とする」relaxed 採点を実装し、過剰減点（false negative）を排除 |
| LLM Judge（2軸） | **relaxed（正規KPI）** = 核心要点の網羅で採点／**strict（副軸）** = 条文番号等まで要求。用途に応じ軸を併記 |
| Oracle RAG | gold 文書を直接文脈に与える理論上界。実測（real）との差分で **retrieval不足 と generation不足 を分離** |
| Retrieval 評価 | top-k（k=1/3/5）の gid hit 率と recall。検索由来の取りこぼしを定量化 |
| 故障タクソノミ | `missing`（検索）/ `omitted`（生成の欠落）/ `misinterpreted`（誤読）/ `factual`（誤情報）/ `overreach`（過剰主張）の5分類で全件ラベル |

## 3. 主要結果

### 統合KPI（全135件）

| 指標 | top-1（out/39） | top-3 採用（out/41） |
|---|---|---|
| **relaxed good（正規KPI）** | 119/135 = **88.1%** | 125/135 = **92.6%** |
| strict good（副軸） | 93/135 = 68.9% | 97/135 = 71.9% |
| top-k gid hit 率 | 88.9% | **97.0%** |
| missing（検索） | 13 (9.6%) | — |
| omitted（生成） | 3 (2.2%) | 3 |
| factual（誤情報） | 2 (1.5%) | 4（希釈コスト） |
| overreach / misinterpreted | 0 / 0 | 0 / 0 |

カテゴリ別（top-1）: service-compare 100% ／ system-explain 94% ／ calc-benefit 86% ／ boundary-case 80% ／ procedure 79%

### 評価が導いた設計判断

- **検索が最大律速と特定** → missing 13件を分析（out/40）。**top-3 で 10件（77%）回収可能**と予測し、実採用で **88.1% → 92.6%（+4.4pt）** を実測（予測一致 100%, out/41）。
  - トレードオフも定量化：top-3 の希釈で factual 2→4（うち1件は別質問 refs 混入による hallucination）。**改善は無料ではない**ことを明示。
- **生成の天井を prompt で突破** → calc-benefit の律速が gold/judge でも検索でもなく **generation policy（数値の省略・過剰要約）** と切り分け（out/34）。
  prompt V2（数値省略禁止＋逃げ条件の限定）で **calc 55%→80%（+25pt）／ easy 87.8%→95.1%（+7.3pt）、回帰ゼロ**（out/35-36）。本番 `rag-mvp.py` に反映済み。
- **モデル比較** → calc 20件で deepseek-v4-flash 85% ≒ claude-sonnet-4 85% ＞ gpt-4o 65%（out/37）。gold tier 再精査後は 95% / 90% / 80%（out/38）。

### 評価設計で踏んだ罠と対処（再現性のための記録）

- **Oracle 非対称の罠**：理論上界（oracle）を実測が超えたら改善でなく評価バグを疑う。judge参照・生成入力・条件を oracle/real で必ず揃える（out/26, out/28 で2回検出し是正）。
- **Judge 厳格性 × 用途のミスマッチ**：条文番号必須の strict は easy 領域で過剰減点（strict 68% vs relaxed 93%）。relaxed を正規KPI、strict を副軸に確定。

## 4. 残課題（→ フェーズ2 へ接続）

故障分離の結果、**RAG の追加最適化（88→95）より、質問特性に応じた経路設計の方が価値が高い**と判断。

- omitted / factual の一部（例: A-076「限度額内で何回利用できるか」）は、**本来一意に定まらない計算をモデルが具体数で捏造**した failure。
  RAG 生成に丸投げせず **計算不能を検出して escalate（ケアマネ試算へ誘導）** すべき領域。
- 算定系のうち式が閉じるもの（入浴介助・栄養改善・特定事業所加算 等）は **決定論計算へ分離**する余地。

→ **フェーズ2: Capability Router**（`out/42`、実測完了）。LLM分類器で knowledge-QA / escalate に振り分け（分類精度 **98.5%**）、escalate には数値捏造を抑止する guardrail 生成を適用。
評価基盤で before/after を実測し relaxed **92.6% → 94.1%（回帰0）**。本番 V2 プロンプトの「数値を出せ⇔出すな」矛盾を route で分離して解消（詳細は `out/42-router.md`）。

## 5. 再現

評価スクリプトは `apps/api/eval/out34-*.py` 〜 `out41-*.py`（全8本）。データは `apps/api/eval/data/`。
主要レポート: `out/39`（統合KPI）／ `out/40`（検索故障分析）／ `out/41`（top-3 実採用）。
