import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { aiQaSchema } from "@/lib/schemas";
import { authMiddleware } from "@/auth/middleware";
import { classifyComplexity } from "@/lib/classify";
import { classifyRoute, buildSystemPrompt } from "@/lib/capability-router";
import { retrieveTopK, RETRIEVAL_K, type RetrievedChunk } from "@/lib/rag";
import { detectRiskyAssertion, withDisclaimer } from "@/lib/guardrail";
import {
  InferenceError,
  OllamaProvider,
  WorkersAiProvider,
  OpenCodeProvider,
  type InferProvider,
} from "@/lib/inference";
import type { AppEnv } from "@/types";
import type { AiQaAnswer, AiTier, AiRoute, AiSource } from "@hybrid/shared";

// handler が topScore/latencyMs を付与する前の本体。finalize/general/domain はこれを返す。
type AiQaBody = Omit<AiQaAnswer, "topScore" | "latencyMs">;

// ドメイン足切り閾値（θ）。top-1 retrieval score がこれ未満なら介護保険ドメイン外。
// 実測（scripts/measure-domain-threshold.ts）: ドメイン内 0.65〜0.72 / 外 0.32〜0.39 → 中点を丸めて 0.5。
const RAG_DOMAIN_THRESHOLD = 0.5;

// edge SLM が自信を持てる下限。これ未満なら cloud へエスカレーション。
const EDGE_CONFIDENCE_THRESHOLD = 0.6;

// edge(SLM) プロバイダ。既定=Workers AI Gemma4 26B A4B。AI_EDGE_PROVIDER=ollama でローカル切替。
function pickEdge(): InferProvider {
  return process.env.AI_EDGE_PROVIDER === "ollama"
    ? new OllamaProvider()
    : new WorkersAiProvider();
}

// 応答を組み立てる単一の出口。免責文(Layer2 ガードレール)を常時付与する。
function finalize(opts: {
  text: string;
  tier: AiTier;
  route: AiRoute;
  routeReason: string;
  confidence: number;
  model: string;
  sources: AiSource[];
  escalatedByGuardrail?: boolean;
  reasons?: string[];
}): AiQaBody {
  return {
    answer: withDisclaimer(opts.text),
    tier: opts.tier,
    route: opts.route,
    routeReason: opts.routeReason,
    confidence: opts.confidence,
    model: opts.model,
    sources: opts.sources,
    safety: {
      disclaimer: true,
      escalatedByGuardrail: opts.escalatedByGuardrail ?? false,
      reasons: opts.reasons ?? [],
    },
  };
}

// ドメイン外(general): RAG を使わず edge↔cloud で回答（フェーズ1のルーティング）。
// 簡単なら edge SLM で完結、複雑/自信不足/医療・法令の断定検知なら cloud へ。
export async function generalAnswer(
  question: string,
  edge: InferProvider,
  cloud: InferProvider,
): Promise<AiQaBody> {
  const base = {
    route: "general" as const,
    routeReason: "介護保険ドメイン外",
    sources: [] as AiSource[],
  };
  // 明らかに重い質問は edge を飛ばして cloud。
  if (classifyComplexity(question) === "complex") {
    const r = await cloud.infer(question);
    return finalize({ ...base, text: r.text, tier: "cloud", confidence: r.confidence, model: cloud.name });
  }
  // edge 一次応答。自信があり危険な断定がなければ採用。
  const slm = await edge.infer(question);
  const guard = detectRiskyAssertion(slm.text);
  if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD && !guard.risky) {
    return finalize({ ...base, text: slm.text, tier: "edge", confidence: slm.confidence, model: edge.name });
  }
  // 自信不足 or 危険な断定 → cloud へエスカレーション。
  const r = await cloud.infer(question);
  return finalize({
    ...base,
    text: r.text,
    tier: "cloud",
    confidence: r.confidence,
    model: cloud.name,
    escalatedByGuardrail: guard.risky,
    reasons: guard.reasons,
  });
}

// ドメイン内(knowledge_qa / escalate): RAG 検索結果を route 別 system prompt で生成する。
//   - knowledge_qa: edge+RAG(V2) を一次生成し A方式 cascade。退化(confidence<閾値)でなく
//     危険な断定もなければ edge で確定（eval out/44: 90.2% good / p50 1.7s、cloud 85.4% を上回る）。
//     退化 or 危険断定なら cloud へ fallback。
//   - escalate: 個別ケースの数値捏造を抑止する意図的エスカレーション → 最初から cloud。
export async function domainAnswer(
  question: string,
  hits: RetrievedChunk[],
  edge: InferProvider,
  cloud: InferProvider,
): Promise<AiQaBody> {
  const decision = await classifyRoute(question, cloud);
  const system = buildSystemPrompt(decision.route, hits.map((h) => h.text));
  const base = {
    route: decision.route,
    routeReason: decision.reason,
    sources: hits.map((h) => ({
      srcId: h.srcId,
      score: h.score,
      excerpt: h.text.replace(/\s+/g, " ").slice(0, 120),
    })),
  };

  if (decision.route === "escalate") {
    const r = await cloud.infer(question, system);
    return finalize({
      ...base,
      text: r.text,
      tier: "cloud",
      confidence: r.confidence,
      model: cloud.name,
      escalatedByGuardrail: true,
      reasons: ["個別ケースの数値結果は一意に確定しないため guardrail 生成"],
    });
  }

  // knowledge_qa: edge+RAG 一次生成 → A方式 cascade。
  const slm = await edge.infer(question, system);
  const guard = detectRiskyAssertion(slm.text);
  if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD && !guard.risky) {
    return finalize({
      ...base,
      text: slm.text,
      tier: "edge",
      confidence: slm.confidence,
      model: edge.name,
    });
  }
  // 退化 or 危険な断定 → cloud へ fallback。
  const r = await cloud.infer(question, system);
  return finalize({
    ...base,
    text: r.text,
    tier: "cloud",
    confidence: r.confidence,
    model: cloud.name,
    escalatedByGuardrail: guard.risky,
    reasons: guard.reasons,
  });
}

// 統合 AI 入口。要認証(JWT)。hc 型推論のためチェーンで定義。
//   段1: RAG 検索 → top-1 score でドメイン内/外を判定
//   段2: ドメイン外 = edge↔cloud（RAGなし） / ドメイン内 = Capability Router + RAG（cloud）
export const aiRoutes = new Hono<AppEnv>()
  .use("*", authMiddleware)
  .post("/qa", zValidator("json", aiQaSchema), async (c) => {
    // latencyMs 起点は handler 冒頭(embed=retrieveTopK の前)に置く。
    // route 決定後に取ると検索(embed)時間が漏れ、真の応答時間にならない。
    const startedAt = Date.now();
    const { question } = c.req.valid("json");
    const edge = pickEdge();
    const cloud = new OpenCodeProvider();
    try {
      const hits = await retrieveTopK(c.get("db"), question, RETRIEVAL_K);
      const topScore = hits[0]?.score ?? 0;
      const body =
        topScore < RAG_DOMAIN_THRESHOLD
          ? await generalAnswer(question, edge, cloud)
          : await domainAnswer(question, hits, edge, cloud);
      return c.json({ ...body, topScore, latencyMs: Date.now() - startedAt });
    } catch (e) {
      if (e instanceof InferenceError) {
        // 推論バックエンド起因の失敗は 502（上流が不調）として返す。
        throw new HTTPException(502, { message: e.message });
      }
      throw e;
    }
  });
