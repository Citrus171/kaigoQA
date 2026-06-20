# 35: calc-benefit system prompt V2 効果測定

`2026-06-19 15:58` / elapsed=276s

## 背景

- out/34: calc-benefit 20件 relaxed 55.0%。retrieval 95% hit で健全、律速は generation
- 主な失敗パターン: 数値省略（5件）・「施設にご確認」逃げ
- 本レポート: system prompt のみ V2 に変更し、同一基盤で効果を測定
- 目的: **generation policy（promptで直る）か capacity 天井（モデル限界）か** を切り分け

## 変更点（out/34 からの差分）

- `EDGE_SYSTEM_PROMPT` を V2 に差し替え（数値省略禁止・核心情報具体化・『施設にご確認』抑制・3〜5文）
- 出力先を `rag-mvp-cloud-calc-v2.jsonl` / `out/35-*.md` に分離
- embed cache は `rag-corpus-embeddings-qlevel-v2.json`(135chunk) を再利用（cache hit）
- judge / 検索 / 対象20件 / モデル / oracle基準 は完全固定

## system prompt V2

```
あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。核心情報は要約や一般論に置き換えず、具体的に記載してください。「施設にご確認ください」「自治体にご確認ください」などの案内は、参考情報に回答が存在しない場合、または施設・自治体ごとに運用が異なる事項に限って使用してください。参考情報に記載されている事実や数値を、この案内によって省略してはいけません。簡潔さは保ちつつ、利用者の判断に必要な数値・条件は漏れなく回答してください。目安は3〜5文です。医療診断・投薬指示・法令の断定はしないこと。
```

## 構成

- corpus: q-level 135 chunks (gold-a 135件)
- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024) — cache hit
- search: top-1 q-level chunk
- cloud: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸, 全ref=gold)
- 評価対象: 20件 (calc-benefit 18 + boundary 2)
- oracle baseline: easy 92.7% (out/33)

## 結果

| 指標 | out/34 (V1) | out/35 (V2) | 改善 |
|---|---|---|---|
| relaxed good | 11/20 = 55.0% | 16/20 = **80.0%** | +25.0pt |
| strict good | 8/20 = 40.0% | 16/20 = 80.0% | +40.0pt |
| top-1 hit率 | 95.0% | 95.0% | — |
| overreach | 0/20 | 0/20 | — |

- easy baseline: 92.7%。差分（easy - calc V2）= **12.7pt**

### bad 3分類 推移（relaxed bad の内訳）

| 分類 | 定義 | out/34 | out/35 | 差分 |
|---|---|---|---|---|
| missing | 不hit | 1 | 1 | +0 |
| misinterpreted | not factual | 1 | 0 | -1 |
| omitted | hit & factual | 7 | 3 | -4 |
| **合計** | | **9** | **4** | **-5** |

**omitted 差分: -4件** ← prompt V2 成否の主指標
- V2 で omitted が 4件 減少。数値省略抑制が機能している
**misinterpreted 差分: -1件** — 数値強制で hallucination が増えていないか監視

### 件別 diff（out/34 → out/35）

| id | out34 relaxed | out35 relaxed | out35 3分類 | out34 reason | out35 reason |
|---|---|---|---|---|---|
| gold-calc-001 | ▪ | G | - | 単位数・併用規定欠落 | 主要事実を網羅し誤りなし |
| gold-calc-002 | ▪ | G | - | 主要事実の一部欠落 | 主要事実網羅し誤りなし |
| gold-calc-003 | ▪ | G | - | 加算単位数・要件が不足 | 主要事実を全て網羅している |
| gold-calc-004 | ▪ | ▪ | omitted | 旧制度前提で現行制度に不適 | 具体的算定条件が不足 |
| gold-calc-005 | ▪ | ▪ | omitted | 単位数の具体的数値が欠落 | 単位数の記載がない |
| gold-calc-006 | G | G | - | 主要事実を全てカバーしている | 全要点を網羅しているため |
| gold-calc-007 | G | G | - | 全要点を正確に網羅 | 全要点を正確に網羅 |
| gold-calc-008 | G | G | - | 主要事実を全てカバー | 主要事実を網羅し誤りなし |
| gold-calc-009 | G | G | - | 主要事実を全てカバーしている | 主要事実を全てカバー |
| gold-calc-010 | G | G | - | 補足情報が欠落 | 全要点を網羅しているため |
| gold-calc-011 | G | G | - | 補足情報が欠落しているため | 全要点網羅し誤りなし |
| gold-calc-012 | ▪ | G | - | 主要事実の一部欠落 | 主要事実を全て網羅 |
| gold-calc-013 | ▪ | ▪ | missing | 包括報酬の説明が誤り | 主要事実の欠落 |
| gold-calc-014 | ▪ | ▪ | omitted | 主要事実の一部欠落 | 単位数・LIFE要件が欠落 |
| gold-calc-015 | G | G | - | 主要事実を網羅し誤りなし | 主要事実を網羅し誤りなし |
| gold-calc-016 | G | G | - | 主要事実を網羅し誤りなし | 主要事実網羅し誤りなし |
| gold-calc-017 | G | G | - | 全要点を網羅している | 全要点を網羅している |
| gold-calc-018 | G | G | - | 補足情報が不足 | 主要事実を全てカバー |
| gold-calc-019 | G | G | - | 主要事実を全てカバー | 全要点を正確に網羅 |
| gold-calc-020 | ▪ | G | - | 年金額18万円基準が欠落 | 全要点を正確に網羅 |

改善: ['gold-calc-001', 'gold-calc-002', 'gold-calc-003', 'gold-calc-012', 'gold-calc-020'] (5件)
悪化: [] (0件)
不変bad: [('gold-calc-004', 'misinterpreted', 'omitted', '旧制度前提で現行制度に不適', '具体的算定条件が不足'), ('gold-calc-005', 'omitted', 'omitted', '単位数の具体的数値が欠落', '単位数の記載がない'), ('gold-calc-013', 'missing', 'missing', '包括報酬の説明が誤り', '主要事実の欠落'), ('gold-calc-014', 'omitted', 'omitted', '主要事実の一部欠落', '単位数・LIFE要件が欠落')] (4件)

## 考察

- **prompt V2 は有効**: relaxed 80.0% (out/34 55.0% から +25.0pt), omitted -4件, 5件改善
- 結論: calc-benefit の新律速は **generation policy（逃げ・要約し過ぎ）**。prompt で解決
- → 本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ V2 を反映を推奨

- easy baseline 92.7% との差 12.7pt（out/34: 37.7pt）