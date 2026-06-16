import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { aiAskSchema } from "@/lib/schemas";
import { authMiddleware } from "@/auth/middleware";
import { classifyComplexity } from "@/lib/classify";
import { getRoutingClassifier } from "@/lib/routing";
import {
  detectRiskyAssertion,
  withDisclaimer,
  type GuardrailResult,
} from "@/lib/guardrail";
import {
  InferenceError,
  OllamaProvider,
  OpenCodeProvider,
  type InferProvider,
} from "@/lib/inference";
import type { AppEnv } from "@/types";
import type { AiAnswer, AiTier } from "@hybrid/shared";

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

// 段1: edge/cloud の事前判定。classifier 有効時は成果物(current.json)ベースの分類器、
// 失敗時/無効時は rule-base にフォールバック（グレースフル）。
// 埋め込みモデルは成果物の embedModel に従う（routing.ts が解決）。prod 埋め込みは将来注入。
async function preRoute(prompt: string): Promise<"edge" | "cloud"> {
  if (USE_CLASSIFIER) {
    try {
      const classifier = getRoutingClassifier();
      return (await classifier.classify(prompt)).tier;
    } catch {
      // 埋め込み不通・次元不一致でも応答を止めない。rule-base へ退避。
    }
  }
  return classifyComplexity(prompt) === "complex" ? "cloud" : "edge";
}

// 応答を組み立てる単一の出口。Layer2 ガードレール（免責文を常時付与）をここで一元適用。
function finalize(
  text: string,
  tier: AiTier,
  confidence: number,
  model: string,
  guardrail?: GuardrailResult,
): AiAnswer {
  return {
    answer: withDisclaimer(text),
    tier,
    confidence,
    model,
    safety: {
      disclaimer: true,
      escalatedByGuardrail: guardrail?.risky ?? false,
      reasons: guardrail?.reasons ?? [],
    },
  };
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
        return c.json(finalize(r.text, "cloud", r.confidence, cloud.name));
      }

      // 段2: SLM 一次応答 + 自信スコア。閾値以上なら Layer2 ガードレールへ。
      const slm = await edge.infer(prompt);
      if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD) {
        // 出力ガードレール: 医療/法令の断定を検知したら edge 回答を破棄し cloud へ。
        const guard = detectRiskyAssertion(slm.text);
        if (!guard.risky) {
          return c.json(finalize(slm.text, "edge", slm.confidence, edge.name));
        }
        const r = await cloud.infer(prompt);
        return c.json(finalize(r.text, "cloud", r.confidence, cloud.name, guard));
      }

      // 自信不足 → cloud LLM へエスカレーション。
      const r = await cloud.infer(prompt);
      return c.json(finalize(r.text, "cloud", r.confidence, cloud.name));
    } catch (e) {
      if (e instanceof InferenceError) {
        // 推論バックエンド起因の失敗は 502（上流が不調）として返す。
        throw new HTTPException(502, { message: e.message });
      }
      throw e;
    }
  });
