import { vi, describe, it, expect, beforeEach } from "vitest";
import { sign } from "hono/jwt";
import type { AiQaAnswer } from "@hybrid/shared";
import type { RoutingLogEntry } from "@/lib/routing-observability";

// routes/ai.ts の HTTP 配線そのものを検証する統合テスト。
// 関数単体(ai-qa.test.ts)では /qa ハンドラの「ドメイン判定 → edge/cloud を
// general/domainAnswer へ渡す配線 → tier 決定」がバイパスされ漏れるため、
// app.request("/ai/qa") 経由で routes 層を実際に通す。
//
// 外部依存(embed=CF / LLM=Workers AI・Ollama・OpenCode)だけを vi.mock で差し替え、
// 配線とドメイン分岐・cascade 分岐は本物のコードを通す。DB は authMiddleware が
// JWT 検証のみ(照合なし)なので不要。

// vi.mock はトップへ巻き上げられるため、制御 state は vi.hoisted で先に定義する。
const h = vi.hoisted(() => ({
  state: {
    topScore: 0.7, // retrieveTopK top-1 score。θ=0.5 を境にドメイン内/外を切替える。
    edgeReply: (_p: string, _s?: string) => ({ text: "edge既定回答です。", confidence: 0.7 }),
    cloudReply: (p: string, _s?: string) =>
      p.includes("ルーターです") // classifyRoute の分類器プロンプト
        ? { text: '{"route":"knowledge_qa","reason":"制度説明"}', confidence: 1 }
        : { text: "cloud生成回答です。", confidence: 0.8 },
    edgeCalls: [] as { prompt: string; system?: string }[],
    cloudCalls: [] as { prompt: string; system?: string }[],
  },
}));

vi.mock("@/lib/rag", () => ({
  RETRIEVAL_K: 3,
  retrieveTopK: async () => [
    { srcId: "doc-1", text: "要介護2の区分支給限度基準額は19,705単位/月です。", score: h.state.topScore },
    { srcId: "doc-2", text: "デイサービスの単位数は提供時間で異なります。", score: h.state.topScore - 0.05 },
  ],
}));

vi.mock("@/lib/inference", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inference")>();
  const mk = (name: string, kind: "edge" | "cloud") => ({
    name,
    infer: async (prompt: string, system?: string) => {
      const st = h.state;
      if (kind === "edge") {
        st.edgeCalls.push({ prompt, system });
        return st.edgeReply(prompt, system);
      }
      st.cloudCalls.push({ prompt, system });
      return st.cloudReply(prompt, system);
    },
  });
  return {
    ...actual, // InferenceError / EDGE_SYSTEM_PROMPT 等は本物を維持
    OllamaProvider: vi.fn(() => mk("ollama:test", "edge")),
    WorkersAiProvider: vi.fn(() => mk("workersai:gemma", "edge")),
    OpenCodeProvider: vi.fn(() => mk("opencode:test", "cloud")),
  };
});

// モック確定後に app を読み込む(動的 import で巻き上げ順を保証)。
const { createApp } = await import("@/app");
const { InferenceError } = await import("@/lib/inference");
const app = createApp({
  getDb: () => ({}) as never, // ai routes は db を引かない
  getJwtSecret: () => "test-secret",
});

// 観測検証用: routingLogger を spy に差し替えた別 app。emit された RoutingLogEntry を捕捉する。
const logged: RoutingLogEntry[] = [];
const appObs = createApp({
  getDb: () => ({}) as never,
  getJwtSecret: () => "test-secret",
  getRoutingLogger: () => ({ log: (e) => void logged.push(e) }),
});

async function postQaObs(
  question: string,
  headers: Record<string, string> = {},
) {
  const token = await sign({ sub: "u1", role: "user" }, "test-secret", "HS256");
  return appObs.request("/ai/qa", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ question }),
  });
}

async function postQa(question: string, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== false) {
    const token = await sign({ sub: "u1", role: "user" }, "test-secret", "HS256");
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await app.request("/ai/qa", {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });
  return res;
}

beforeEach(() => {
  // 既定 = ドメイン内・knowledge_qa・edge good。各テストで必要分だけ上書きする。
  h.state.topScore = 0.7;
  h.state.edgeReply = () => ({ text: "edge既定回答です。", confidence: 0.7 });
  h.state.cloudReply = (p) =>
    p.includes("ルーターです")
      ? { text: '{"route":"knowledge_qa","reason":"制度説明"}', confidence: 1 }
      : { text: "cloud生成回答です。", confidence: 0.8 };
  h.state.edgeCalls = [];
  h.state.cloudCalls = [];
  logged.length = 0;
});

describe("POST /ai/qa: routes 配線(ドメイン判定 → edge/cloud 委譲 → tier)", () => {
  it("認証なし → 401", async () => {
    const res = await postQa("自己負担割合はどう決まりますか", { auth: false });
    expect(res.status).toBe(401);
  });

  it("ドメイン内 knowledge_qa + edge good → routes が edge を domainAnswer に渡し tier=edge で確定", async () => {
    h.state.topScore = 0.7; // ≥ θ=0.5 → domainAnswer 経路
    const res = await postQa("自己負担割合はどう決まりますか");
    const body = (await res.json()) as AiQaAnswer;

    expect(res.status).toBe(200);
    expect(body.route).toBe("knowledge_qa");
    expect(body.tier).toBe("edge"); // ← routes が edge を委譲した証拠(直呼びでは検証できない配線)
    expect(body.model).toBe("workersai:gemma");
    expect(body.sources.map((s) => s.srcId)).toEqual(["doc-1", "doc-2"]);
    expect(body.safety.escalatedByGuardrail).toBe(false);
    // cloud は分類1回のみ、生成は edge。
    expect(h.state.cloudCalls).toHaveLength(1);
    expect(h.state.edgeCalls).toHaveLength(1);
    // edge 生成には V2 RAG system(参考情報)が渡る。
    expect(h.state.edgeCalls[0]!.system).toContain("回答の参考情報");
    // 観測フィールド: topScore=retrieveTopK の top-1、latencyMs=handler 入口起点の処理時間。
    expect(body.topScore).toBe(0.7);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("ドメイン内 knowledge_qa + edge 退化(空応答) → cloud へ fallback (tier=cloud)", async () => {
    h.state.topScore = 0.7;
    h.state.edgeReply = () => ({ text: "", confidence: 0 }); // 退化
    const res = await postQa("自己負担割合はどう決まりますか");
    const body = (await res.json()) as AiQaAnswer;

    expect(body.tier).toBe("cloud");
    expect(body.model).toBe("opencode:test");
    expect(body.safety.escalatedByGuardrail).toBe(false); // 退化は guardrail 起因ではない
    expect(h.state.cloudCalls).toHaveLength(2); // 分類 + fallback 生成
  });

  it("ドメイン内 knowledge_qa + edge が危険な断定 → 破棄して cloud、guardrail 理由を記録", async () => {
    h.state.topScore = 0.7;
    h.state.edgeReply = () => ({ text: "それは違法です。", confidence: 0.7 }); // risky
    const res = await postQa("生活保護受給中でも使えますか");
    const body = (await res.json()) as AiQaAnswer;

    expect(body.tier).toBe("cloud");
    expect(body.safety.escalatedByGuardrail).toBe(true);
    expect(body.safety.reasons).toContain("legal:legality");
  });

  it("ドメイン内 escalate → edge を呼ばず最初から cloud", async () => {
    h.state.topScore = 0.7;
    h.state.cloudReply = (p) =>
      p.includes("ルーターです")
        ? { text: '{"route":"escalate","reason":"個別の金額算定"}', confidence: 1 }
        : { text: "手順と制度の枠組みを説明します。", confidence: 0.8 };
    const res = await postQa("母は要介護2、毎月いくら払いますか");
    const body = (await res.json()) as AiQaAnswer;

    expect(body.route).toBe("escalate");
    expect(body.tier).toBe("cloud");
    expect(body.safety.escalatedByGuardrail).toBe(true);
    expect(h.state.edgeCalls).toHaveLength(0); // escalate は edge を使わない
  });

  it("ドメイン外(top-1 score < θ) → RAGなし general 経路、sources は空", async () => {
    h.state.topScore = 0.3; // < θ=0.5 → generalAnswer 経路
    const res = await postQa("おすすめの本は何ですか");
    const body = (await res.json()) as AiQaAnswer;

    expect(body.route).toBe("general");
    expect(body.tier).toBe("edge");
    expect(body.sources).toEqual([]);
    expect(h.state.cloudCalls).toHaveLength(0); // ドメイン外 simple は分類も生成も cloud 不要
    expect(body.topScore).toBe(0.3); // sources 空でもドメイン判定 score は出力される
  });
});

describe("POST /ai/qa: Router Observability emit(routingLogger に流す RoutingDecision)", () => {
  // emit は fire-and-forget(queryRef を await してから log)。レスポンス後の microtask で確定するため待つ。
  const waitLogged = () => vi.waitFor(() => expect(logged).toHaveLength(1));

  it("成功(ドメイン内 knowledge_qa + edge good): retrieval/stage1/stage2/served を実態どおり記録", async () => {
    h.state.topScore = 0.7;
    const res = await postQaObs("自己負担割合はどう決まりますか");
    expect(res.status).toBe(200);
    await waitLogged();
    const e = logged[0]!;

    // 段0 RAG: top-1 score・ドメイン判定・参照は srcId のみ(PII非保持)。
    expect(e.retrieval.topScore).toBe(0.7);
    expect(e.retrieval.domain).toBe("in");
    expect(e.retrieval.retrieved.map((r) => r.srcId)).toEqual(["doc-1", "doc-2"]);
    // 段1 Capability Router: ドメイン内のみ記録。LLM 分類で knowledge_qa。
    expect(e.stage1).toMatchObject({ method: "llm", route: "knowledge_qa" });
    // 段2 cascade: edge good なので巻き戻し無し。
    expect(e.stage2).toMatchObject({ escalated: false, guardrailEscalated: false });
    expect(e.served).toBe("edge");
    expect(e.errorCode).toBeNull();
    expect(e.versions.genModel).toBe("workersai:gemma");
    // PII非保持: answerRef は sha256 先端16hex(本文ではない)。
    expect(e.answerRef).toMatch(/^[0-9a-f]{16}$/);
    expect(e.queryRef).toMatch(/^[0-9a-f]{16}$/);
  });

  it("成功(ドメイン外 general): stage1 は未記録(undefined)・served=edge", async () => {
    h.state.topScore = 0.3; // < θ → general
    await postQaObs("おすすめの本は何ですか");
    await waitLogged();
    const e = logged[0]!;

    expect(e.retrieval.domain).toBe("out");
    expect(e.stage1).toBeUndefined(); // general は段1未実行
    expect(e.served).toBe("edge");
    expect(e.errorCode).toBeNull();
  });

  it("X-Request-ID を伝播すると観測の reqId に踏襲する(BFF↔api 相関)", async () => {
    h.state.topScore = 0.7;
    await postQaObs("自己負担割合はどう決まりますか", { "X-Request-ID": "bff-req-abc123" });
    await waitLogged();
    expect(logged[0]!.reqId).toBe("bff-req-abc123");
  });

  it("エラー(retrieval 成功後に推論失敗): topScore/domain/retrieved を忠実に残し served=null/errorCode を記録", async () => {
    h.state.topScore = 0.7; // retrieval は成功 → retrievalState が埋まる
    // classifyRoute(最初の cloud 呼び出し)で Timeout。retrieval 成功後の推論失敗を再現。
    h.state.cloudReply = () => {
      throw new InferenceError("opencode:test", "Timeout: cloud が応答しませんでした");
    };
    const res = await postQaObs("自己負担割合はどう決まりますか");
    expect(res.status).toBe(502); // InferenceError → 上流不調

    await waitLogged();
    const e = logged[0]!;
    // 推論が落ちても retrieval の実態は残す(topScore:0/domain:out と誤記録しない)。
    expect(e.retrieval.topScore).toBe(0.7);
    expect(e.retrieval.domain).toBe("in");
    expect(e.retrieval.retrieved.map((r) => r.srcId)).toEqual(["doc-1", "doc-2"]);
    // 出力は無し、errorCode で障害種別を記録。
    expect(e.served).toBeNull();
    expect(e.answerRef).toBeNull();
    expect(e.errorCode).toBe("timeout");
    expect(e.versions.genModel).toBe("unknown");
  });
});
