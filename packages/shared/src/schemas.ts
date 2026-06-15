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

// AIハイブリッドルーティング（SLM⇄LLM）のリクエスト。
export const aiAskSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "プロンプトは必須です")
    .max(4000, "プロンプトは4000文字以内で入力してください"),
});

// 応答の tier: edge=ローカル/エッジSLMで完結, cloud=クラウドLLMへエスカレーション。
export const aiTierSchema = z.enum(["edge", "cloud"]);

export const aiAnswerSchema = z.object({
  answer: z.string(),
  tier: aiTierSchema,
  confidence: z.number().min(0).max(1),
  model: z.string(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type AiAskInput = z.infer<typeof aiAskSchema>;
export type AiTier = z.infer<typeof aiTierSchema>;
export type AiAnswer = z.infer<typeof aiAnswerSchema>;
