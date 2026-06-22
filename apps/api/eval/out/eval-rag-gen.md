# RAG + 生成品質 eval

- 日時: 2026-06-22T11:09:06.563Z
- elapsed: 949s
- 対象: 実クエリ 26件 / generator=opencode-go:deepseek-v4-flash / judge=opencode-go:deepseek-v4-flash
- retrieval: hybrid(RRF w5:1 c=10) k=5
- **注意: 生成と judge が同一モデル = 自己採点バイアスあり（cloud good率は楽観側）**

## サマリー

| 指標 | 値 |
|---|---|
| good rate | 80.8% (21/26) |
| judged | 26/26 |
| gen_failed | 0 |
| ok | 21 (80.8%) |
| partial | 2 (7.7%) |
| refusal | 2 (7.7%) |
| hallucination | 1 (3.8%) |

## route 分布

| route | n |
|---|---|
| knowledge_qa | 22 |
| escalate | 4 |

## 件別

| id | category | route | top1 score | 正解順位 | top-1 | verdict | reason |
|---|---|---|---|---|---|---|---|
| gold-A-001 | system-explain | knowledge_qa | 0.476 | top-2 | gold-A-042 | good | 中心要点をすべて含み正確 |
| gold-A-002 | system-explain | knowledge_qa | 0.545 | top-4 | gold-A-082 | good | 中心要点を全て満たす |
| gold-A-003 | system-explain | knowledge_qa | 0.545 | top-1 | 正解 | refusal | judge採点不能 |
| gold-A-004 | system-explain | knowledge_qa | 0.545 | top-3 | gold-calc-011 | refusal | judge採点不能 |
| gold-A-005 | system-explain | knowledge_qa | 0.545 | top-1 | 正解 | partial | 第2号被保険者の保険料に触れていない |
| gold-A-006 | system-explain | knowledge_qa | 0.545 | top-1 | 正解 | good | 全中心要点を満たし誤りなし |
| gold-A-061 | calc-benefit | escalate | 0.472 | top-4 | gold-calc-015 | good | 中心要点を全て満たし事実誤認なし |
| gold-A-062 | calc-benefit | escalate | 0.545 | top-1 | 正解 | good | 全ての中心要点を実質的に満たす |
| gold-A-064 | calc-benefit | knowledge_qa | 0.545 | top-4 | gold-calc-014 | good | 全中心要点を過不足なく満たしている |
| gold-A-065 | calc-benefit | knowledge_qa | 0.455 | 圏外 | gold-A-082 | hallucination | 医療保険者への言及など事実誤認あり |
| gold-A-066 | calc-benefit | escalate | 0.455 | top-3 | gold-calc-017 | good | 中心要点すべて充足、事実と一致 |
| gold-A-067 | calc-benefit | knowledge_qa | 0.531 | top-1 | 正解 | good | 中心要点を全て含み誤りなし |
| gold-A-037 | procedure | knowledge_qa | 0.510 | top-1 | 正解 | good | 全ての要点を過不足なく満たしている |
| gold-A-038 | procedure | knowledge_qa | 0.502 | top-1 | 正解 | good | 全ての中心要点を満たし正確 |
| gold-A-039 | procedure | knowledge_qa | 0.538 | top-1 | 正解 | good | 全中心要点を充足 |
| gold-A-040 | procedure | knowledge_qa | 0.531 | top-1 | 正解 | good | 中心要点すべて網羅し誤りなし |
| gold-A-041 | procedure | knowledge_qa | 0.545 | top-1 | 正解 | good | 全ての中心要点を満たし事実誤認なし |
| gold-A-103 | boundary-case | knowledge_qa | 0.521 | top-1 | 正解 | good | 全要点を満たし正確で過不足なし |
| gold-A-104 | boundary-case | knowledge_qa | 0.545 | top-1 | 正解 | good | 全中心要点を過不足なく満たす |
| gold-A-105 | boundary-case | knowledge_qa | 0.531 | top-4 | gold-A-082 | good | 全ての中心要点を満たし事実誤認なし |
| gold-A-106 | boundary-case | knowledge_qa | 0.502 | top-1 | 正解 | good | 全中心要点を過不足なく満たす |
| gold-A-107 | boundary-case | knowledge_qa | 0.483 | top-2 | gold-A-119 | good | 中心要点を全て満たしている |
| gold-A-085 | service-compare | knowledge_qa | 0.545 | top-1 | 正解 | partial | 安否確認や健康型に触れず不十分 |
| gold-A-086 | service-compare | escalate | 0.545 | top-1 | 正解 | good | 中心要点を過不足なく満たす |
| gold-A-087 | service-compare | knowledge_qa | 0.531 | top-1 | 正解 | good | 中心要点を全て含み事実誤認なし |
| gold-A-088 | service-compare | knowledge_qa | 0.545 | top-1 | 正解 | good | 全中心要点を満たし事実誤認なし |
