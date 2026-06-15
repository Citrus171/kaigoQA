import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { aiAskSchema } from "@/lib/schemas";
import { authMiddleware } from "@/auth/middleware";
import { classifyComplexity } from "@/lib/classify";
import { OllamaEmbedProvider } from "@/lib/embed";
import { getRoutingClassifier } from "@/lib/routing";
import {
  InferenceError,
  OllamaProvider,
  OpenCodeProvider,
  type InferProvider,
} from "@/lib/inference";
import type { AppEnv } from "@/types";
import type { AiAnswer } from "@hybrid/shared";

// edge SLM が自信を持てる下限。これ未満なら cloud へエスカレーション。
const EDGE_CONFIDENCE_THRESHOLD = 0.6;

// 段1ルータの選択。"classifier"=セントロイド分類器(要embedding)、それ以外=rule-base。
// 既定はrule-base（既存挙動・prod/テストに無影響）。classifier は当面 dev のみ。
const USE_CLASSIFIER = (process.env.AI_ROUTER ?? "rule") === "classifier";

/**
 * edge(SLM) プロバイダを環境に応じて選ぶ。
 * - prod(Workers): Workers AI binding（後続タスク・localhost不可のため）
 * - dev(Node): このPCの Ollama
 */
function pickEdge(_c: unknown): InferProvider {
  // 後続: c.env?.AI があれば WorkersAiProvider。現状 dev = Ollama のみ。
  return new OllamaProvider();
}

// 段1ルータの埋め込みは使い回す（同一インスタンスでセントロイドを再利用）。
// dev=Ollama。prod 埋め込み(bge等)は後続で c.env から解決する。
const embedProvider = USE_CLASSIFIER ? new OllamaEmbedProvider() : null;

// 段1: edge/cloud の事前判定。classifier 有効時は埋め込み分類器、
// 失敗時/無効時は rule-base にフォールバック（グレースフル）。
async function preRoute(prompt: string): Promise<"edge" | "cloud"> {
  if (embedProvider) {
    try {
      const classifier = await getRoutingClassifier(embedProvider);
      return (await classifier.classify(prompt)).tier;
    } catch {
      // 埋め込み不通でも応答を止めない。rule-base へ退避。
    }
  }
  return classifyComplexity(prompt) === "complex" ? "cloud" : "edge";
}

// hc 型推論のためチェーンで定義。要認証（JWT middleware）。
export const aiRoutes = new Hono<AppEnv>()
  .use("*", authMiddleware)
  .post("/ask", zValidator("json", aiAskSchema), async (c) => {
    const { prompt } = c.req.valid("json");
    const edge = pickEdge(c);
    const cloud = new OpenCodeProvider();

    try {
      // 段1: edge/cloud 事前判定（分類器 or rule-base）。cloud なら SLM を飛ばす。
      if ((await preRoute(prompt)) === "cloud") {
        const r = await cloud.infer(prompt);
        const body: AiAnswer = {
          answer: r.text,
          tier: "cloud",
          confidence: r.confidence,
          model: cloud.name,
        };
        return c.json(body);
      }

      // 段2: SLM 一次応答 + 自信スコア。閾値以上なら edge で完結。
      const slm = await edge.infer(prompt);
      if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD) {
        const body: AiAnswer = {
          answer: slm.text,
          tier: "edge",
          confidence: slm.confidence,
          model: edge.name,
        };
        return c.json(body);
      }

      // 自信不足 → cloud LLM へエスカレーション。
      const r = await cloud.infer(prompt);
      const body: AiAnswer = {
        answer: r.text,
        tier: "cloud",
        confidence: r.confidence,
        model: cloud.name,
      };
      return c.json(body);
    } catch (e) {
      if (e instanceof InferenceError) {
        // 推論バックエンド起因の失敗は 502（上流が不調）として返す。
        throw new HTTPException(502, { message: e.message });
      }
      throw e;
    }
  });
