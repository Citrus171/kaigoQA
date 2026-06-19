# 36: easy 41件 prompt V2 回帰確認

`2026-06-19 16:15` / elapsed=388s

## 背景

- out/35: prompt V2 が calc-benefit を relaxed 55%→80%(+25pt, 悪化0) に改善。律速=generation policy と確定
- 本レポート: **V2 本番反映前の最終ゲート**。easy 41件で V2 が回帰しないか確認
- 焦点: 長文化(3〜5文)・数値強制が easy で overreach/factual/冗長partial を誘発しないか

## 対象

- easy 41件（expected=edge, out/33 と同一固定集合）
- gold-a total 135件。新 calc20 は expected=cloud で混入なし (Claude確認済)
- baseline verdict: `rejudge-2axis-verdicts.json` (41件)

## 構成

- corpus: q-level 135 chunks (gold-a 135件)
- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024) — cache hit
- search: top-1 q-level chunk
- cloud: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 2軸, 全ref=gold)
- prompt: V2 (数値省略禁止・3〜5文)
- 🔴 oracle guard: 無効化

## system prompt V2 (out/35 と同一)

```
あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。核心情報は要約や一般論に置き...
```

## baseline（out/33 旧prompt）

- relaxed good: 36/41 = **87.8%**
- strict good: 13/41 = 31.7%
- overreach: 0
- factual誤り: 1

## 結果

| 指標 | out/33 (旧prompt) | out/36 (V2) | 差分 |
|---|---|---|---|
| relaxed good | 36/41 = 87.8% | 39/41 = **95.1%** | +7.3pt |
| strict good | 13/41 = 31.7% | 19/41 = 46.3% | +14.6pt |
| overreach | 0 | 0 | ✅ 0維持 |
| factual誤り | 1 | 1 | +0 |
| top-1 hit率 | — | 39/41 = 95.1% | — |

### bad 3分類（relaxed bad 内訳）

| 分類 | 件数 |
|---|---|
| missing (不hit) | 2 |
| misinterpreted (not factual) | 0 |
| omitted (hit & factual) | 0 |
| **合計** | **2** |

### 件別 diff（out/33 旧prompt → out/36 V2）

| id | 旧prompt relaxed | V2 relaxed | 変化 | V2 3分類 | V2 reason |
|---|---|---|---|---|---|
| gold-A-001 | G | G | =good | - | 施行年欠落でstrict不足 |
| gold-A-002 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-003 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-004 | G | G | =good | - | 主要事実を網羅し誤りなし |
| gold-A-005 | G | G | =good | - | 主要事実網羅し誤りなし |
| gold-A-006 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-008 | G | G | =good | - | 法令条番号の欠落 |
| gold-A-009 | G | G | =good | - | 主要事実を網羅し補足も不要 |
| gold-A-010 | G | G | =good | - | 主要事実網羅し補足情報不要 |
| gold-A-011 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-013 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-014 | G | G | =good | - | 補足情報が不足しているため |
| gold-A-026 | G | G | =good | - | 全要点網羅し誤りなし |
| gold-A-027 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-028 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-029 | G | G | =good | - | 補足情報が欠落 |
| gold-A-030 | G | G | =good | - | 法令条番号の欠落 |
| gold-A-031 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-032 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-033 | G | G | =good | - | 全要点網羅 |
| gold-A-037 | ▪ | G | ↑改善 | - | 補足情報が欠落している |
| gold-A-038 | ▪ | ▪ | =bad | missing | 主要事実の提示がない |
| gold-A-039 | ▪ | G | ↑改善 | - | 全要点網羅し誤りなし |
| gold-A-040 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-041 | G | G | =good | - | 補足情報が欠落 |
| gold-A-042 | ▪ | ▪ | =bad | missing | 主要事実の脱退不可を欠落 |
| gold-A-060 | ▪ | G | ↑改善 | - | 補足情報が不足しているため |
| gold-A-085 | G | G | =good | - | 全要点を網羅しているため |
| gold-A-086 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-087 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-088 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-089 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-090 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-091 | G | G | =good | - | 法令条番号の欠落 |
| gold-A-092 | G | G | =good | - | 法令条番号の欠落 |
| gold-A-097 | G | G | =good | - | 全要点を正確に網羅 |
| gold-A-098 | G | G | =good | - | 補足情報が欠落しているため |
| gold-A-099 | G | G | =good | - | 補足情報が欠落 |
| gold-A-102 | G | G | =good | - | 補足情報が不足 |
| gold-A-103 | G | G | =good | - | 主要事実を全て網羅している |
| gold-A-115 | G | G | =good | - | 全要点を網羅している |

改善: ['gold-A-037', 'gold-A-039', 'gold-A-060'] (3件)
悪化: [] (0件)
不変bad: ['gold-A-038', 'gold-A-042'] (2件)

## 合格判定

- **✅** relaxed ≥ 87.8%
- **✅** overreach = 0
- **✅** factual ≤ 1

### **合格** — V2 を本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ反映可能

- relaxed 95.1% ≥ 87.8%（悪化なし、改善あり）
- overreach = 0 維持
- factual誤り = 1 ≤ 1（増加なし）

## 考察

- easy 41件で V2 は回帰なし、relaxed 95.1% 維持／改善。overreach/factual も悪化なし
- calc-benefit(+25pt) + easy(回帰なし) の両面で V2 の安全性と有効性を確認
- → **V2 を本番 `EDGE_SYSTEM` へ恒久反映可能**。残存 calc omitted 3件は capacity 天井で別途

- calc-benefit V2 の結果 (out/35, relaxed 80.0%) と合わせた金領域 good 率の概算: 実装価値あり