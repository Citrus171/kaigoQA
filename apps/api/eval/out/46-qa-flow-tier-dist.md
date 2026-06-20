# 46: 本番 /ai/qa フロー実測 (gold-a 41件・tier/latency 分布・judge無し)

`2026-06-20T10:15:15.267Z` / 構成: edge=Workers AI Gemma4 thinkOFF / cloud=OpenCode deepseek-v4-flash / embed=CF bge-m3

## route 分布 (段1 ドメイン判定 + 段2 classifyRoute)
- knowledge_qa: 41 / escalate: 0 / general: 0 / ERR: 0

## tier 分布
- edge: 41 / cloud: 0 / ERR: 0

## A方式 cascade 実機 fallback 率 (knowledge_qa のみ)
- edge 確定: 41 / 41
- cloud fallback: 0 / 41 = 0.0%
  - (out/45 シミュレーションは fallback 0% だった。実機での差分に注目)
- guardrail エスカレ件数(escalatedByGuardrail かつ knowledge_qa): 0

## 空答率
- empty: 0 / 41

## latency 分布 (ms)
- 全体: p50=4414 / p95=7318 / max=35031 (n=41)
- edge tier: p50=4414 / p95=7318 / max=35031 (n=41)
- cloud tier: (n=0)

## エラー (status != 200)
- なし
