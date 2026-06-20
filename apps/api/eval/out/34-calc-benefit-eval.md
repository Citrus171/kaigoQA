# 34: 新calc-benefit 20件 relaxed/strict 2軸評価

`2026-06-19 15:35` / elapsed=221s

## 背景

- out/33 で easy 41件の relaxed good 87.8% を検証。easy期待値 92.7% に対して厳格寄りだが実用十分
- 本レポート: verified方式で追加した calc-benefit 20件（報酬・算定・制度境界の難所）を同一基盤で評価
- 目的: easyとの差分で **retrieval / reasoning / factual のどこに次投資すべきか** を判断

## 構成

- corpus: q-level 135 chunks (gold-a 135件の全ref連結)
- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024)
- search: top-1 q-level chunk
- cloud: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸, 全ref=gold)
- 評価対象: 20件 (calc-benefit 18 + boundary 2)
- oracle baseline: easy 92.7% (out/33)

## 評価軸の定義

- **relaxed（正規KPI）**: 利用者が次に取るべき行動・理解すべき主要事実を得られれば good。法令条番号・条文引用・年号・限度額・行政注記の欠落は許容。**ただし質問の核心（帰結情報・算定要件・金額・条件）の欠落は不可**
- **strict（副軸・参考）**: gold 全要点を網羅して good
- factual / overreach は両軸とも厳格維持

## tier 分離

- 評価対象 20件: main=122, supplement=1, total=123
- supp率: 0.8%

## 結果

- **relaxed good**: 11/20 = **55.0%** ← 正規KPI
- **strict good**: 8/20 = 40.0% ← 副軸（参考）
- easy baseline (out/33): 92.7%
- 差分: **-37.7pt**

### 故障分解

- retrieval failure (自問不hit): 1/20 = 5.0%
- reasoning failure (hitだがrelaxed bad): 8/20 = 40.0%
- factual errors: 2/20 = 10.0%
- top-1 gid hit率: 19/20 = 95.0%

### 内訳

| id | category | top1 hit | relaxed | strict | reason |
|---|---|---|---|---|---|
| gold-calc-001 | calc-benefit | Y | ▪ | ▪ | 単位数・併用規定欠落 |
| gold-calc-002 | calc-benefit | Y | ▪ | ▪ | 主要事実の一部欠落 |
| gold-calc-003 | calc-benefit | Y | ▪ | ▪ | 加算単位数・要件が不足 |
| gold-calc-004 | calc-benefit | Y | ▪ | ▪ | 旧制度前提で現行制度に不適 |
| gold-calc-005 | calc-benefit | Y | ▪ | ▪ | 単位数の具体的数値が欠落 |
| gold-calc-006 | calc-benefit | Y | G | G | 主要事実を全てカバーしている |
| gold-calc-007 | calc-benefit | Y | G | G | 全要点を正確に網羅 |
| gold-calc-008 | calc-benefit | Y | G | G | 主要事実を全てカバー |
| gold-calc-009 | calc-benefit | Y | G | G | 主要事実を全てカバーしている |
| gold-calc-010 | calc-benefit | Y | G | ▪ | 補足情報が欠落 |
| gold-calc-011 | calc-benefit | Y | G | ▪ | 補足情報が欠落しているため |
| gold-calc-012 | calc-benefit | Y | ▪ | ▪ | 主要事実の一部欠落 |
| gold-calc-013 | calc-benefit | N | ▪ | ▪ | 包括報酬の説明が誤り |
| gold-calc-014 | calc-benefit | Y | ▪ | ▪ | 主要事実の一部欠落 |
| gold-calc-015 | calc-benefit | Y | G | G | 主要事実を網羅し誤りなし |
| gold-calc-016 | calc-benefit | Y | G | G | 主要事実を網羅し誤りなし |
| gold-calc-017 | calc-benefit | Y | G | G | 全要点を網羅している |
| gold-calc-018 | calc-benefit | Y | G | ▪ | 補足情報が不足 |
| gold-calc-019 | boundary-case | Y | G | G | 主要事実を全てカバー |
| gold-calc-020 | boundary-case | Y | ▪ | ▪ | 年金額18万円基準が欠落 |

relaxed bad (9件): ['gold-calc-001', 'gold-calc-002', 'gold-calc-003', 'gold-calc-004', 'gold-calc-005', 'gold-calc-012', 'gold-calc-013', 'gold-calc-014', 'gold-calc-020']
strict bad (12件): ['gold-calc-001', 'gold-calc-002', 'gold-calc-003', 'gold-calc-004', 'gold-calc-005', 'gold-calc-010', 'gold-calc-011', 'gold-calc-012', 'gold-calc-013', 'gold-calc-014', 'gold-calc-018', 'gold-calc-020']

### 失敗パターン分析

9件のrelaxed badをパターン分類:

**A. 数値欠落 (5件)**: self-hitだが具体的な単位数・金額・加算率を回答に含めていない
| id | query概要 | 欠落した数値 |
|---|---|---|
| gold-calc-001 | 入浴介助加算の条件 | 単位数(40/55単位)・併用規定 |
| gold-calc-003 | BPSD関連加算 | 加算単位数(3/4単位)・細目要件 |
| gold-calc-005 | LIFE加算のデータ提出要件 | 単位数(40/50〜60単位/月) |
| gold-calc-012 | 特定事業所加算I〜V | 人材要件（介護福祉士30%等）・加算Vの併算定詳細 |
| gold-calc-020 | 年金天引きvs普通徴収 | 年金年額18万円基準 |

→ モデルは概念・条件を理解しているが、**具体的数値を回答に織り込めない**傾向。回答末尾に「詳細は施設にご確認ください」で逃げるパターンあり。これは system prompt の制約「事実が確認できない場合は施設にご確認ください」に引きずられている可能性。

**B. 事実誤認 (2件)**:
| id | query概要 | 誤り内容 |
|---|---|---|
| gold-calc-004 | 処遇改善加算同時算定 | 新旧一本化を「別々に算定する制度ではない」と断じ、経過措置（令和6年度末まで区分V）を正しく説明できず outdated 判定 |
| gold-calc-013 | 看小多機の複合型サービス費 | 自質問不hit(gold-A-084にhit)。月額包括報酬の説明が「利用日数×単位数」になっている hallucination |

**C. 不十分な説明 (1件)**:
| id | query概要 | 問題 |
|---|---|---|
| gold-calc-002 | オペレーター加算要件 | 前提誤り（独立加算は存在しない）を正しく指摘したが、24時間通報対応加算(610単位)の具体値を含めず partial 判定 |

**D. 最小限回答 (1件)**:
| id | query概要 | 問題 |
|---|---|---|
| gold-calc-014 | 口腔機能向上加算・資格要件 | 「看護職員でも要件を満たす」と核心に答えたが、単位数(150/160単位/回)やLIFE関連要件に言及せず partial |

### 検索の質

- top-1 gid hit率: 19/20 = **95.0%** — 既存easy(65.9%)を大きく上回る。calc-benefitは参照情報が特徴的(金額・要件)で cosine 識別性が高いと推測
- retrieval failure は gold-calc-013 のみ。gold-A-084「訪問看護の保険外併用療養費」に引きずられた

## 考察

- **relaxed good 55.0%** は easy 92.7%（out/33実測87.8%）から **-37.7pt**。calc-benefit領域が予想通り難所であることを定量確認
- 9件中8件が **generation/reasoning failure**（search hitしても回答不十分）。retrieval律速(1件)ではない
- **最大の課題**: モデルが具体数値を回答に含めない傾向（5件）。system promptで「施設にご確認」逃げが起きている可能性

### 次投資判断

1. **generation改善が最優先**。retrievalは95% hitで十分。数値回答強制のprompt調整でどこまで改善するか検証すべき
2. **既存hedge calc-benefit 19件(gold-A-061等)のverified化優先度: 低**。out/34の主因はgeneration capacityであり、gold qualityの問題ではない。19件はhedge方式だがrelaxed軸では supplemental 注記扱いになり、実用判断に支障しない
3. **factual誤り2件(gold-calc-004 outdated, gold-calc-013 hallucination)** はそれぞれgeneration改善とretrievalで対応可能

### 機械検算結果

- relaxed good率の独立再計算: 11/20 = 55.0%（stored値と一致 ✅）
- stored good_relaxed/good_strict の不一致: 0件 ✅
- 全回答 non-empty / gen失敗 0件 → oracle対称性: OK ✅
- factual誤り: 2件（gold-calc-004: outdated, gold-calc-013: hallucination ✅）
- overreach: 0件 ✅
- retrieval failure: 1件（gold-calc-013 → gold-A-084 ✅）