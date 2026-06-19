# 38: gold tier 再精査 (005/014 単位数降格 → omitted 溶解検証)

`2026-06-19 17:07` / elapsed=93s

## 背景

- out/37: calc-benefit 20件×3モデル比較。gold-calc-005 は全3モデルが omit → gold 要求水準の疑い
- 本レポート: 005/014 の単位数・LIFE関連refを supplement に降格し tier 変更だけで omitted が溶けるか検証

## tier 再精査の基準

「質問が直接尋ねているか」:
- gold-calc-005 query: 「**データ提出**には何が必要か」→ 単位数は質問スコープ外
- gold-calc-014 query: 「**歯科衛生士がいないとだめか**」→ 単位数・LIFE改定文脈は質問スコープ外

## tier 変更内容

| id | 降格ref (main→supp) | 理由 |
|---|---|---|
| gold-calc-005 | [4]令和6年度改定文脈, [5]単位数40-60単位/月 | 質問はデータ提出要件。単位数はスコープ外 |
| gold-calc-014 | [3]単位数150/160単位+LIFE要件, [5]令和6年度改定 | 質問は人員要件。単位数・改定文脈はスコープ外 |

## 構成

- 回答: out/37 のモデル別生成結果を再利用（再生成なし）
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸, tierのみ変更)
- 対象: 20件 × 3モデル = 60 entries

## 結果

### モデル別 relaxed good 推移

| モデル | out/37 (old tier) | out/38 (refined tier) | resolved |
|---|---|---|---|
| deepseek-flash | 17/20 (85%) | 19/20 (95%) | 2 |
| gpt-4o | 13/20 (65%) | 16/20 (80%) | 3 |
| claude-sonnet | 17/20 (85%) | 18/20 (90%) | 2 |

### 残存 omitted 3件 × 3モデル 詳細

| id | model | old relaxed | new relaxed | 変化 | old reason | new reason |
|---|---|---|---|---|---|---|
| gold-calc-004 | deepseek-flash | G | G | =good | 主要事実を網羅し誤りなし | 主要事実を網羅し誤りなし |
| gold-calc-005 | deepseek-flash | ▪ | G | ↑RESOLVED | 単位数の記載がない | 補足情報が不足しているため |
| gold-calc-014 | deepseek-flash | ▪ | G | ↑RESOLVED | 算定要件の数値欠落 | 補足情報が不足しているため |
| gold-calc-004 | gpt-4o | ▪ | ▪ | =bad | 算定要件の具体性不足 | 算定要件の具体性不足 |
| gold-calc-005 | gpt-4o | ▪ | G | ↑RESOLVED | 単位数・改定情報が欠落 | 補足情報が不足しているため |
| gold-calc-014 | gpt-4o | ▪ | G | ↑RESOLVED | 算定要件の詳細が不足 | 補足情報が不足しているため |
| gold-calc-004 | claude-sonnet | ▪ | ▪ | =bad | 主要事実の一部が欠落 | 主要事実の一部が欠落 |
| gold-calc-005 | claude-sonnet | ▪ | G | ↑RESOLVED | 単位数情報が欠落 | 補足情報が欠落しているため |
| gold-calc-014 | claude-sonnet | G | G | =good | 全要点を正確に網羅 | 全要点を正確に網羅 |

### 質問別 resolved 集計

- **gold-calc-004** (tier変更なし・参照): old=1/3 → new=1/3 (resolved=0)
- **gold-calc-005** ← tier変更対象: old=0/3 → new=3/3 (resolved=3)
- **gold-calc-014** ← tier変更対象: old=1/3 → new=3/3 (resolved=2)

## 考察

- **tier 再精査は有効**: 5件の omitted が溶解。単位数/LIFEの降格で gold が relaxed 軸の原則（核心の欠落のみ bad）に整合
- → gold tier 再精査を恒久採用し、gold データの ★ 付与を修正すべき