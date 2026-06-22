import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { aiQaSchema } from "@/lib/schemas";
import { authMiddleware } from "@/auth/middleware";
import { classifyComplexity } from "@/lib/classify";
import { classifyRoute, buildSystemPrompt } from "@/lib/capability-router";
import { retrieveTopK, RETRIEVAL_K, type RetrievedChunk } from "@/lib/rag";
import { detectRiskyAssertion, withDisclaimer } from "@/lib/guardrail";
import { CfBgeM3EmbedProvider } from "@/lib/cf-embed";
import {
  InferenceError,
  OllamaProvider,
  WorkersAiProvider,
  OpenCodeProvider,
  type InferProvider,
} from "@/lib/inference";
import type { AppEnv } from "@/types";
import type { AiQaAnswer, AiTier, AiRoute, AiSource } from "@hybrid/shared";
import type { RoutingDecision } from "@/lib/routing-model";
import { queryRef, answerRef, type RoutingLogger } from "@/lib/routing-observability";

// handler が topScore/latencyMs を付与する前の本体。finalize/general/domain はこれを返す。
type AiQaBody = Omit<AiQaAnswer, "topScore" | "latencyMs">;

// generalAnswer/domainAnswer の戻り値。AiQaBody + 観測用 cascade メタ。
// AiQaBody の全プロパティを直に持つ（テスト/ハンドラで .route/.tier 等に直接アクセス可）+
// cascade は観測組み立て用。ハンドラは { ...result（=AiQaBody部分）, topScore } でレスポンス。
type AnswerResult = AiQaBody & {
  cascade: {
    served: AiTier; // 実際に返した tier（edge/cloud）
    edgeConfidence: number; // edge 一次応答の confidence（cloud 直接時は cloud の値）
    escalated: boolean; // 自信不足で cloud へ巻き戻し
    guardrailEscalated: boolean; // ガードレール（危険断定）で cloud へ巻き戻し
  };
};

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
): Promise<AnswerResult> {
  const base = {
    route: "general" as const,
    routeReason: "介護保険ドメイン外",
    sources: [] as AiSource[],
  };
  // 明らかに重い質問は edge を飛ばして cloud。
  if (classifyComplexity(question) === "complex") {
    const r = await cloud.infer(question);
    return {
      ...finalize({ ...base, text: r.text, tier: "cloud", confidence: r.confidence, model: cloud.name }),
      cascade: { served: "cloud", edgeConfidence: r.confidence, escalated: false, guardrailEscalated: false },
    };
  }
  // edge 一次応答。自信があり危険な断定がなければ採用。
  const slm = await edge.infer(question);
  const guard = detectRiskyAssertion(slm.text);
  if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD && !guard.risky) {
    return {
      ...finalize({ ...base, text: slm.text, tier: "edge", confidence: slm.confidence, model: edge.name }),
      cascade: { served: "edge", edgeConfidence: slm.confidence, escalated: false, guardrailEscalated: false },
    };
  }
  // 自信不足 or 危険な断定 → cloud へエスカレーション。
  const r = await cloud.infer(question);
  return {
    ...finalize({
      ...base,
      text: r.text,
      tier: "cloud",
      confidence: r.confidence,
      model: cloud.name,
      escalatedByGuardrail: guard.risky,
      reasons: guard.reasons,
    }),
    cascade: {
      served: "cloud",
      edgeConfidence: slm.confidence,
      escalated: slm.confidence < EDGE_CONFIDENCE_THRESHOLD,
      guardrailEscalated: guard.risky,
    },
  };
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
): Promise<AnswerResult> {
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
    return {
      ...finalize({
        ...base,
        text: r.text,
        tier: "cloud",
        confidence: r.confidence,
        model: cloud.name,
        escalatedByGuardrail: true,
        reasons: ["個別ケースの数値結果は一意に確定しないため guardrail 生成"],
      }),
      // escalate は意図的エスカレーション（cascade 非発火）。guardrail 生成扱い。
      cascade: { served: "cloud", edgeConfidence: r.confidence, escalated: false, guardrailEscalated: true },
    };
  }

  // knowledge_qa: edge+RAG 一次生成 → A方式 cascade。
  const slm = await edge.infer(question, system);
  const guard = detectRiskyAssertion(slm.text);
  if (slm.confidence >= EDGE_CONFIDENCE_THRESHOLD && !guard.risky) {
    return {
      ...finalize({
        ...base,
        text: slm.text,
        tier: "edge",
        confidence: slm.confidence,
        model: edge.name,
      }),
      cascade: { served: "edge", edgeConfidence: slm.confidence, escalated: false, guardrailEscalated: false },
    };
  }
  // 退化 or 危険な断定 → cloud へ fallback。
  const r = await cloud.infer(question, system);
  return {
    ...finalize({
      ...base,
      text: r.text,
      tier: "cloud",
      confidence: r.confidence,
      model: cloud.name,
      escalatedByGuardrail: guard.risky,
      reasons: guard.reasons,
    }),
    cascade: {
      served: "cloud",
      edgeConfidence: slm.confidence,
      escalated: slm.confidence < EDGE_CONFIDENCE_THRESHOLD,
      guardrailEscalated: guard.risky,
    },
  };
}

// retrieval 観測ブロック。成功/エラー両経路で同形に組む。
// state が null（retrieval 段で失敗）なら topScore:0/domain:out/空配列。
function retrievalBlock(
  state: { topScore: number; domain: "in" | "out"; retrieved: { srcId: string; score: number }[] } | null,
  latencyEmbed: number,
  embedModel: string,
): RoutingDecision["retrieval"] {
  return {
    topScore: state?.topScore ?? 0,
    domain: state?.domain ?? "out",
    retrieved: state?.retrieved ?? [],
    latencyEmbed,
    embedModel,
  };
}

// 観測 emit。queryRef を非同期計算してから fire-and-forget で log（リクエストを止めない）。
function emitDecision(
  logger: RoutingLogger,
  decision: RoutingDecision,
  reqId: string,
  startedAt: number,
  question: string,
): void {
  void (async () => {
    try {
      logger.log({ ...decision, reqId, ts: startedAt, queryRef: await queryRef(question) });
    } catch {
      // 観測は best-effort。
    }
  })();
}

// 統合 AI 入口。要認証(JWT)。hc 型推論のためチェーンで定義。
//   段0: RAG 検索 → top-1 score でドメイン内/外を判定
//   段1: ドメイン外 = edge↔cloud（RAGなし） / ドメイン内 = Capability Router + RAG（cloud）
//   観測: RoutingDecision を組み立て c.get("routingLogger").log() へ fire-and-forget。
//        蓄積されるのは Node(dev/k3d)=Postgres のみ。Workers 本番は現状 noop（将来 Analytics Engine）。
export const aiRoutes = new Hono<AppEnv>()
  .use("*", authMiddleware)
  .post("/qa", zValidator("json", aiQaSchema), async (c) => {
    // latencyMs 起点は handler 冒頭(embed=retrieveTopK の前)に置く。
    // route 決定後に取ると検索(embed)時間が漏れ、真の応答時間にならない。
    const startedAt = Date.now();
    const { question } = c.req.valid("json");
    const edge = pickEdge();
    const cloud = new OpenCodeProvider();
    // embed provider を明示的に構築し model 名を観測に使う（retrieveTopK の既定と同一）。
    const embedProvider = new CfBgeM3EmbedProvider();
    const logger = c.get("routingLogger");
    // BFF が X-Request-ID を伝播してきたら踏襲（web ログと突き合わせ可能）。無ければ自前採番。
    const reqId = c.req.header("X-Request-ID") ?? crypto.randomUUID();
    let retrievalLatency = 0;
    // retrieval 結果を try 外に保持し、catch で実態に忠実な観測を可能にする。
    // 推論失敗時（retrieval 成功後）に topScore:0/domain:out と誤記録するのを防ぐ。
    let retrievalState: {
      topScore: number;
      domain: "in" | "out";
      retrieved: { srcId: string; score: number }[];
    } | null = null;
    try {
      const embedStart = Date.now();
      const hits = await retrieveTopK(c.get("db"), question, RETRIEVAL_K, embedProvider);
      retrievalLatency = Date.now() - embedStart;
      const topScore = hits[0]?.score ?? 0;
      const domain: "in" | "out" = topScore < RAG_DOMAIN_THRESHOLD ? "out" : "in";
      retrievalState = {
        topScore,
        domain,
        retrieved: hits.map((h) => ({ srcId: h.srcId, score: h.score })),
      };
      const result =
        domain === "out"
          ? await generalAnswer(question, edge, cloud)
          : await domainAnswer(question, hits, edge, cloud);
      const totalLatency = Date.now() - startedAt;
      // 観測レコード組み立て（PII: queryRef=sha256先端 / answerRef=sha256先端 / retrieved=srcId のみ）
      const decision: RoutingDecision = {
        retrieval: retrievalBlock(retrievalState, retrievalLatency, embedProvider.name),
        // ドメイン内のみ LLM 分類を記録。general は段1未実行。
        stage1:
          domain === "in"
            ? {
                method: "llm",
                route: result.route,
                routeReason: result.routeReason,
                classifierVersion: cloud.name,
              }
            : undefined,
        stage2: {
          edgeConfidence: result.cascade.edgeConfidence,
          escalated: result.cascade.escalated,
          guardrailEscalated: result.cascade.guardrailEscalated,
        },
        served: result.cascade.served,
        answerRef: await answerRef(result.answer),
        errorCode: null,
        versions: {
          classifierVersion: cloud.name,
          genModel: result.model,
        },
        latencyMs: {
          gen: totalLatency - retrievalLatency,
          total: totalLatency,
        },
      };
      emitDecision(logger, decision, reqId, startedAt, question);
      // cascade は観測用メタ。レスポンスからは除外（AiQaBody + topScore/latencyMs のみ）。
      const { cascade: _cascade, ...responseBody } = result;
      return c.json({ ...responseBody, topScore, latencyMs: totalLatency });
    } catch (e) {
      // エラー時も観測。retrieval 成功後の推論失敗なら実態（topScore/domain/retrieved）を記録、
      // retrieval 段の失敗なら retrievalState は null で topScore:0/domain:out。
      const totalLatency = Date.now() - startedAt;
      // errorCode は InferenceError が kind/status から導く（message 文字列マッチ廃止）。
      const errorCode = e instanceof InferenceError ? e.errorCode : "internal";
      emitDecision(
        logger,
        {
          retrieval: retrievalBlock(retrievalState, retrievalLatency, embedProvider.name),
          served: null,
          answerRef: null,
          errorCode,
          versions: { classifierVersion: cloud.name, genModel: "unknown" },
          latencyMs: { gen: 0, total: totalLatency },
        },
        reqId,
        startedAt,
        question,
      );
      if (e instanceof InferenceError) {
        // 推論バックエンド起因の失敗は 502（上流が不調）として返す。
        throw new HTTPException(502, { message: e.message });
      }
      throw e;
    }
  });
