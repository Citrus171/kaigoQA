# 48: 実機スモーク tier別 latency（cloud+RAG 含む）

`2026-06-20` / dev:api 本番構成（edge=Workers AI Gemma4 thinkOFF / cloud=OpenCode deepseek-v4-flash / embed=CF bge-m3）。手動スモーク実測。

## 実測値

| 経路 | route / tier | latency | 生成往復の内訳 |
|---|---|---|---|
| **edge+RAG** | knowledge_qa / edge | **4.16s** | embed(CF) + classify(cloud 1往復) + edge 生成 |
| **cloud+RAG** | escalate / cloud | **E1 29.32s / E2 22.50s** | embed(CF) + classify(cloud) + 生成(cloud) = **cloud 2往復** |

- edge+RAG スモーク質問: 「要介護認定の申請はどこにすればよいですか」
- cloud+RAG スモーク質問: E1「母は要介護2、デイサービス週3回で毎月いくら」/ E2「限度額内で訪問看護は最大何回」
- cloud+RAG 両件とも sources(RAG) 3件付与・`escalatedByGuardrail=true`（数値捏造抑止の guardrail 生成）を確認。

## 参考: out/46 本番フロー41件（全件 knowledge_qa / edge tier）
- p50 **4.4s** / p95 7.3s / max 35.0s（escalate は 0件だったため未計上＝本ファイルが escalate=cloud+RAG の latency 初実測）

## 考察（律速の所在）
- **cloud+RAG(escalate) は cloud 2往復で 22〜29s**。律速は OpenCode(cloud) の応答時間（out/44 cloud avg 8.98s/件 ×2往復 + embed）。
- **edge+RAG(knowledge_qa) でも classify の cloud 1往復が latency に乗る**（edge 生成自体は general 経路で実測 〜0.9s）。
- → 最適化候補: 分類(classifyRoute)の脱 cloud 化（edge 分類／ヒューリスティック判定）。詳細はメモリ future-features 項目8。
