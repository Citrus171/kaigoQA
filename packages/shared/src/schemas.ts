import { z } from "zod";

// Zod = 単一の真実。api(検証) と web(react-hook-form) で共有する。

export const loginSchema = z.object({
  email: z.string().email("メールアドレスの形式が不正です"),
  password: z.string().min(1, "パスワードは必須です"),
});

export const createTodoSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "タイトルは必須です")
    .max(100, "タイトルは100文字以内で入力してください"),
});

export const setDoneSchema = z.object({
  done: z.boolean(),
});

// 応答の tier: edge=ローカル/エッジSLMで完結, cloud=クラウドLLMへエスカレーション。
export const aiTierSchema = z.enum(["edge", "cloud"]);

// 出力ガードレール(Layer2)の結果。免責付与の有無・断定検知でのエスカレ有無・検知理由。
export const aiSafetySchema = z.object({
  disclaimer: z.boolean(),
  escalatedByGuardrail: z.boolean(),
  reasons: z.array(z.string()),
});

// 統合 AI 入口（/ai/qa）の質問リクエスト。ドメイン判定 → ルーティングで答える。
export const aiQaSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "質問は必須です")
    .max(4000, "質問は4000文字以内で入力してください"),
});

// Router の振り分け先:
//   knowledge_qa = 介護保険ドメイン・参考知識で回答（RAG + cloud）
//   escalate     = 個別ケースの数値結果（捏造抑止 guardrail + cloud）
//   general      = ドメイン外（retrieval score 低）。RAG を使わず edge↔cloud で回答
export const aiRouteSchema = z.enum(["knowledge_qa", "escalate", "general"]);

// RAG で参照したコーパスチャンク（出典）。score はコサイン類似（正規化済み内積）。
export const aiSourceSchema = z.object({
  srcId: z.string(),
  score: z.number(),
  excerpt: z.string(),
});

export const aiQaAnswerSchema = z.object({
  answer: z.string(),
  // tier=どこで生成したか（edge SLM / cloud LLM）, route=振り分け先, confidence=生成側の確信度。
  tier: aiTierSchema,
  route: aiRouteSchema,
  routeReason: z.string(),
  confidence: z.number().min(0).max(1),
  model: z.string(),
  // sources=RAG 出典（general 経路は RAG を使わないため空配列）。
  sources: z.array(aiSourceSchema),
  safety: aiSafetySchema,
  // 観測用: topScore=ドメイン判定の top-1 retrieval score / latencyMs=ルート入口起点の総処理時間(embed込み)。
  topScore: z.number(),
  latencyMs: z.number().int().min(0),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type AiTier = z.infer<typeof aiTierSchema>;
export type AiSafety = z.infer<typeof aiSafetySchema>;
export type AiQaInput = z.infer<typeof aiQaSchema>;
export type AiRoute = z.infer<typeof aiRouteSchema>;
export type AiSource = z.infer<typeof aiSourceSchema>;
export type AiQaAnswer = z.infer<typeof aiQaAnswerSchema>;
