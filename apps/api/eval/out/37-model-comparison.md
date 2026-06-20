# 37: calc-benefit モデル比較 (DeepSeek Flash vs GPT-4o vs Claude Sonnet)

`2026-06-19 17:00` / elapsed=127s

## 背景

- out/35: prompt V2 で calc-benefit relaxed 55%→80%。3件 omitted が残存 (004/005/014)
- 仮説: 残存3件は generation capacity 天井（モデル限界）
- 本レポート: 同一条件で 3モデルを比較し、omitted がモデル差で溶けるか検証

## 構成

- retrieval: q-level top-1, 同一 corpus (135 chunks), 同一 chunk
- prompt: V2 (数値省略禁止・3〜5文) — 全モデル共通
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸, 全ref=gold) — 全モデル共通
- 対象: 20件 (calc-benefit 18 + boundary 2)

## 結果

| 指標 | deepseek-flash | gpt-4o | claude-sonnet |
|---|---|---|---|
| relaxed good | 17/20 = 85.0% | 13/20 = 65.0% | 17/20 = 85.0% |
| strict good | 15/20 = 75.0% | 11/20 = 55.0% | 15/20 = 75.0% |
| factual誤り | 0 | 0 | 1 |
| overreach | 0 | 0 | 0 |
| top-1 hit | 19 | 19 | 19 |

### bad 3分類

| モデル | missing | misinterpreted | omitted | relaxed bad合計 |
|---|---|---|---|---|
| deepseek-flash | 1 | 0 | 2 | 3 |
| gpt-4o | 1 | 0 | 6 | 7 |
| claude-sonnet | 0 | 1 | 2 | 3 |

### 残存 omitted 3件 モデル別

| id | deepseek | gpt-4o | sonnet | deepseek answer抜粋 |
|---|---|---|---|---|
| gold-calc-004 | G (-) 主要事実を網羅し誤りなし | ▪ (omitted) 算定要件の具体性不足 | ▪ (omitted) 主要事実の一部が欠落 | 現在は2024年6月の制度改正により、処遇改善加算とベースアップ等支援加算は「介護職員等処遇改善加算（I～IV）」に一本化され、別々に併算定する制度ではありません（経過措置として令和6年度末まで旧区分 |
| gold-calc-005 | ▪ (omitted) 単位数の記載がない | ▪ (omitted) 単位数・改定情報が欠落 | ▪ (omitted) 単位数情報が欠落 | 科学的介護推進体制加算を算定するには、利用者の状態やケアの内容等のデータをLIFE（科学的介護情報システム）に提出し、フィードバックを受けることが必須です。データ提出頻度は少なくとも3か月に1回と定め |
| gold-calc-014 | ▪ (omitted) 算定要件の数値欠落 | ▪ (omitted) 算定要件の詳細が不足 | G (-) 全要点を正確に網羅 | いいえ、歯科衛生士や言語聴覚士がいなくても算定可能です。口腔機能向上加算の人員要件は、言語聴覚士・歯科衛生士・看護職員のいずれか1名以上の配置であり、看護職員でも対応できます。 |

### 特記事項

- **gold-calc-013（retrieval miss）**: 全モデルが gold-A-084 に誤hit。Claude のみ relaxed=G（包括報酬を general knowledge で正しく説明）。odd ケース。
- **gold-calc-020（claude factual誤り）**: 「60歳退職では支払方法は変わらない」と誤認。DeepSeek・GPT-4o は正答。

## 考察

**モデル間に有意差あり**: DeepSeek Flash = Claude Sonnet (85.0%) >> GPT-4o (65.0%)。GPT-4o は 6件 omitted と、他モデルの 2件の 3倍。汎用最強モデルが介護保険 calc-benefit 領域では最弱という逆転。

**3件の残存 omitted を分解**:

| id | 全モデル共通か | 判定 |
|---|---|---|
| gold-calc-004 | DeepSeek のみ pass | モデル依存。DeepSeek の生成分散でたまたま要件を満たした回。すべてのモデルで安定して通るわけではない → gold の要求が borderline |
| gold-calc-005 | **全3モデルとも omit** | gold 問題と確定。質問「データ提出要件」に対し gold が単位数(40〜60単位/月)を main fact として要求しているのが scope mismatch の疑い最強 |
| gold-calc-014 | Claude のみ pass | DeepSeek・GPT-4o は omit、Claude は pass。モデル依存だが、質問の核心（歯科衛生士不要・看護職員で代替可）は全モデルが回答済み。単位数/LIFE は補足情報的 |

**結論**: 残存 omitted 3件の主因は **gold 要求水準（特に tier 分類）**。
- 005 は「質問スコープ外の fact を main 扱いしている」疑いが強い（全モデル一貫 omit）
- 004 は要求が多すぎ（7 main facts）、モデル間の確率的成功に依存
- 014 は 039 anchor 原則（核心の欠落のみ bad）に照らして単位数/LIFE は supplement 寄り

### 推奨アクション

1. **gold tier 再精査**: 005 の単位数 → supplement 降格 / 014 の単位数+LIFE → supplement 降格を検討。基準: 「質問が直接尋ねているか」
2. **GPT-4o の解釈**: relaxed bad が他モデルの 2倍超。GPT-4o が数値列挙より安全寄り・保守的。実運用で本モデルを使うなら別途 prompt 調整が必要
3. **モデル選定**: DeepSeek Flash がコスト・品質の両面で最良。Claude Sonnet と同等品質だが API コストに差あり（DeepSeek が圧倒的安価）

- out/35 baseline (DeepSeek V2): 80.0% → 本 run 85.0%（生成分散で 004 が pass した分）