import { describe, it, expect } from "vitest";
import { generalAnswer, domainAnswer } from "../src/routes/ai";
import type { InferProvider } from "../src/lib/inference";
import type { RetrievedChunk } from "../src/lib/rag";
import { CONSTANTS_TEXT, KNOWLEDGE_QA_SYSTEM } from "../src/lib/capability-router";
import { AI_DISCLAIMER } from "../src/lib/guardrail";

// provider をネット非依存の fake に差し替え、infer の呼び出し(prompt/system)を記録する。
// reply は prompt に応じて応答を返す（domainAnswer は分類と生成で同じ cloud を2回呼ぶため）。
function fakeProvider(
  name: string,
  reply: (prompt: string, system?: string) => { text: string; confidence: number },
) {
  const calls: { prompt: string; system?: string }[] = [];
  const provider: InferProvider = {
    name,
    async infer(prompt, system) {
      calls.push({ prompt, system });
      return reply(prompt, system);
    },
  };
  return { provider, calls };
}

const hits: RetrievedChunk[] = [
  { srcId: "doc-1", text: "要介護2の区分支給限度基準額は19,705単位/月です。", score: 0.71 },
  { srcId: "doc-2", text: "デイサービスの単位数は提供時間で異なります。", score: 0.66 },
];

// classifyRoute は分類器プロンプト(「…ルーターです」)を system なしで呼ぶ。生成は system 付き。
const isClassifierCall = (prompt: string) => prompt.includes("ルーターです");

describe("domainAnswer: ドメイン内(RAG)の route 別生成 + edge cascade", () => {
  // 分類は edge(Workers AI) で行う(latency 律速の cloud 往復を排除)。edge fake は
  // 分類器プロンプトには route JSON を、生成プロンプト(system 付き)には答案を返す。
  const edgeRouter = (route: "escalate" | "knowledge_qa", reason: string, gen: { text: string; confidence: number }) =>
    fakeProvider("workersai:gemma", (prompt) =>
      isClassifierCall(prompt) ? { text: `{"route":"${route}","reason":"${reason}"}`, confidence: 1 } : gen,
    );

  it("escalate: 分類は edge、生成は cloud で guardrail プロンプト(制度定数)。edge では生成しない", async () => {
    const { provider: edge, calls: edgeCalls } = edgeRouter("escalate", "個別の金額算定", {
      text: "edge 生成は使われないはず",
      confidence: 0.7,
    });
    const { provider: cloud, calls } = fakeProvider("opencode:test", () => ({
      text: "手順と制度の枠組みを説明します。",
      confidence: 0.8,
    }));

    const r = await domainAnswer("母は要介護2、毎月いくら払いますか", hits, edge, cloud);

    expect(r.route).toBe("escalate");
    expect(r.routeReason).toBe("個別の金額算定");
    expect(r.tier).toBe("cloud");
    expect(r.confidence).toBe(0.8);
    // edge は分類1回のみ。escalate は edge で生成しない(数値捏造抑止の意図的エスカレ)。
    expect(edgeCalls).toHaveLength(1);
    expect(isClassifierCall(edgeCalls[0]!.prompt)).toBe(true);
    expect(edgeCalls[0]!.system).toBeUndefined();
    // cloud は生成1回。escalate 専用の制度定数ブロックが system に入っている。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain(CONSTANTS_TEXT);
    // RAG 出典が付与され、escalate は意図的エスカレーションとして記録される。
    expect(r.sources.map((s) => s.srcId)).toEqual(["doc-1", "doc-2"]);
    expect(r.safety.escalatedByGuardrail).toBe(true);
    expect(r.safety.reasons.length).toBeGreaterThan(0);
    expect(r.answer).toContain(AI_DISCLAIMER);
  });

  it("knowledge_qa + edge 自信あり + 危険なし → edge+RAG(V2) で確定(cloud は未使用)", async () => {
    const { provider: edge, calls: edgeCalls } = edgeRouter("knowledge_qa", "制度説明", {
      text: "自己負担割合は所得に応じて1〜3割で決まります。",
      confidence: 0.7,
    });
    const { provider: cloud, calls: cloudCalls } = fakeProvider("opencode:test", () => ({
      text: "クラウド回答(使われないはず)",
      confidence: 0.8,
    }));

    const r = await domainAnswer("自己負担割合はどう決まりますか", hits, edge, cloud);

    expect(r.route).toBe("knowledge_qa");
    expect(r.tier).toBe("edge");
    expect(r.model).toBe("workersai:gemma");
    expect(r.confidence).toBe(0.7);
    // edge は分類(1回目) + 生成(2回目)。生成は V2(KNOWLEDGE_QA_SYSTEM)を system に受ける。
    expect(edgeCalls).toHaveLength(2);
    expect(edgeCalls[1]?.system?.startsWith(KNOWLEDGE_QA_SYSTEM)).toBe(true);
    expect(edgeCalls[1]?.system).not.toContain(CONSTANTS_TEXT);
    // cloud は分類にも生成にも使われない(OpenCode 呼び出しゼロ)。
    expect(cloudCalls).toHaveLength(0);
    expect(r.safety.escalatedByGuardrail).toBe(false);
    expect(r.safety.reasons).toEqual([]);
    expect(r.sources).toHaveLength(2);
    expect(r.answer).toContain(AI_DISCLAIMER);
  });

  it("knowledge_qa + edge 退化(空応答 confidence0) → cloud へ fallback", async () => {
    const { provider: edge, calls: edgeCalls } = edgeRouter("knowledge_qa", "制度説明", {
      text: "", // 退化出力 → outputConfidence=0 で閾値割れ
      confidence: 0,
    });
    const { provider: cloud, calls: cloudCalls } = fakeProvider("opencode:test", () => ({
      text: "クラウドの詳しい回答です。",
      confidence: 0.8,
    }));

    const r = await domainAnswer("自己負担割合はどう決まりますか", hits, edge, cloud);

    expect(r.tier).toBe("cloud");
    expect(r.model).toBe("opencode:test");
    expect(r.confidence).toBe(0.8);
    expect(edgeCalls).toHaveLength(2); // 分類 + 退化した一次生成
    expect(cloudCalls).toHaveLength(1); // fallback 生成のみ
    expect(cloudCalls[0]?.system?.startsWith(KNOWLEDGE_QA_SYSTEM)).toBe(true);
    expect(r.safety.escalatedByGuardrail).toBe(false); // 退化は guardrail 起因ではない
    expect(r.sources).toHaveLength(2);
  });

  it("knowledge_qa + edge が危険な断定 → 破棄して cloud、guardrail 理由を記録", async () => {
    const { provider: edge, calls: edgeCalls } = edgeRouter("knowledge_qa", "制度説明", {
      text: "それは違法です。", // 法令断定 → guardrail risky。confidence は高いが採用しない
      confidence: 0.7,
    });
    const { provider: cloud, calls: cloudCalls } = fakeProvider("opencode:test", () => ({
      text: "安全なクラウド回答です。",
      confidence: 0.8,
    }));

    const r = await domainAnswer("生活保護受給中でも使えますか", hits, edge, cloud);

    expect(r.tier).toBe("cloud");
    expect(edgeCalls).toHaveLength(2); // 分類 + 危険な一次生成
    expect(cloudCalls).toHaveLength(1); // fallback 生成のみ
    expect(r.safety.escalatedByGuardrail).toBe(true);
    expect(r.safety.reasons).toContain("legal:legality");
  });

  it("sources の excerpt は空白正規化のうえ120字に丸める", async () => {
    const longHits: RetrievedChunk[] = [
      { srcId: "long", text: "あ　".repeat(200), score: 0.7 },
    ];
    const { provider: edge } = edgeRouter("knowledge_qa", "r", { text: "回答します。", confidence: 0.7 });
    const { provider: cloud } = fakeProvider("opencode:test", () => ({ text: "クラウド", confidence: 0.8 }));

    const r = await domainAnswer("質問", longHits, edge, cloud);

    expect(r.sources[0]!.excerpt.length).toBe(120);
    expect(r.sources[0]!.excerpt).not.toContain("　"); // 全角空白は単一スペースへ正規化
  });
});

describe("generalAnswer: ドメイン外(RAGなし edge↔cloud)", () => {
  // edge は呼ばれないことの検証用に、呼ばれたら例外的に分かる応答を返す。
  const cloudOnly = () =>
    fakeProvider("opencode:test", () => ({ text: "クラウド回答", confidence: 0.8 }));

  it("simple + edge 自信あり + 危険なし → edge で完結(sources空)", async () => {
    const { provider: edge } = fakeProvider("workersai:gemma", () => ({
      text: "一般的なご質問にお答えします。",
      confidence: 0.9,
    }));
    const { provider: cloud, calls: cloudCalls } = cloudOnly();

    const r = await generalAnswer("おすすめの本は何ですか", edge, cloud);

    expect(r.route).toBe("general");
    expect(r.tier).toBe("edge");
    expect(r.confidence).toBe(0.9);
    expect(r.model).toBe("workersai:gemma");
    expect(r.sources).toEqual([]);
    expect(cloudCalls).toHaveLength(0); // cloud にエスカレーションしていない
    expect(r.answer).toContain(AI_DISCLAIMER);
  });

  it("simple + edge 自信不足 → cloud へエスカレーション", async () => {
    const { provider: edge } = fakeProvider("workersai:gemma", () => ({
      text: "わかりません",
      confidence: 0.3,
    }));
    const { provider: cloud, calls: cloudCalls } = cloudOnly();

    const r = await generalAnswer("曖昧な質問", edge, cloud);

    expect(r.tier).toBe("cloud");
    expect(r.model).toBe("opencode:test");
    expect(cloudCalls).toHaveLength(1);
    expect(r.safety.escalatedByGuardrail).toBe(false);
  });

  it("simple + edge が危険な断定 → 破棄して cloud へ、guardrail 理由を記録", async () => {
    const { provider: edge } = fakeProvider("workersai:gemma", () => ({
      text: "それは違法です。",
      confidence: 0.95, // 自信は高いが危険な断定なので採用しない
    }));
    const { provider: cloud, calls: cloudCalls } = cloudOnly();

    // 質問自体は無害・simple。edge(fake) が危険な断定を返すケースを検証する。
    const r = await generalAnswer("あなたの感想を教えて", edge, cloud);

    expect(r.tier).toBe("cloud");
    expect(cloudCalls).toHaveLength(1);
    expect(r.safety.escalatedByGuardrail).toBe(true);
    expect(r.safety.reasons).toContain("legal:legality");
  });

  it("complex(キーワード) → edge を飛ばして直接 cloud", async () => {
    const { provider: edge, calls: edgeCalls } = fakeProvider("workersai:gemma", () => ({
      text: "使われないはず",
      confidence: 0.9,
    }));
    const { provider: cloud, calls: cloudCalls } = cloudOnly();

    const r = await generalAnswer("確定申告の税金計算を手伝って", edge, cloud);

    expect(r.tier).toBe("cloud");
    expect(edgeCalls).toHaveLength(0); // edge は一度も呼ばれない
    expect(cloudCalls).toHaveLength(1);
  });
});
