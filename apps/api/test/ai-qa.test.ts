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

describe("domainAnswer: ドメイン内(RAG + cloud)の route 別生成", () => {
  it("escalate: guardrail プロンプト(制度定数)で生成し、sources と escalate フラグを付ける", async () => {
    const { provider: cloud, calls } = fakeProvider("opencode:test", (prompt) =>
      isClassifierCall(prompt)
        ? { text: '{"route":"escalate","reason":"個別の金額算定"}', confidence: 1 }
        : { text: "手順と制度の枠組みを説明します。", confidence: 0.8 },
    );

    const r = await domainAnswer("母は要介護2、毎月いくら払いますか", hits, cloud);

    expect(r.route).toBe("escalate");
    expect(r.routeReason).toBe("個別の金額算定");
    expect(r.tier).toBe("cloud");
    expect(r.confidence).toBe(0.8);
    // 生成呼び出し(2回目)の system に escalate 専用の制度定数ブロックが入っている。
    expect(calls[1]?.system).toContain(CONSTANTS_TEXT);
    // RAG 出典が付与され、escalate は意図的エスカレーションとして記録される。
    expect(r.sources.map((s) => s.srcId)).toEqual(["doc-1", "doc-2"]);
    expect(r.safety.escalatedByGuardrail).toBe(true);
    expect(r.safety.reasons.length).toBeGreaterThan(0);
    expect(r.answer).toContain(AI_DISCLAIMER);
  });

  it("knowledge_qa: V2(数値省略禁止)プロンプトで生成し、escalate フラグは立てない", async () => {
    const { provider: cloud, calls } = fakeProvider("opencode:test", (prompt) =>
      isClassifierCall(prompt)
        ? { text: '{"route":"knowledge_qa","reason":"制度説明"}', confidence: 1 }
        : { text: "自己負担割合は所得で決まります。", confidence: 0.8 },
    );

    const r = await domainAnswer("自己負担割合はどう決まりますか", hits, cloud);

    expect(r.route).toBe("knowledge_qa");
    expect(calls[1]?.system?.startsWith(KNOWLEDGE_QA_SYSTEM)).toBe(true);
    expect(calls[1]?.system).not.toContain(CONSTANTS_TEXT);
    expect(r.safety.escalatedByGuardrail).toBe(false);
    expect(r.safety.reasons).toEqual([]);
    expect(r.sources).toHaveLength(2);
  });

  it("sources の excerpt は空白正規化のうえ120字に丸める", async () => {
    const longHits: RetrievedChunk[] = [
      { srcId: "long", text: "あ　".repeat(200), score: 0.7 },
    ];
    const { provider: cloud } = fakeProvider("opencode:test", (prompt) =>
      isClassifierCall(prompt)
        ? { text: '{"route":"knowledge_qa","reason":"r"}', confidence: 1 }
        : { text: "回答", confidence: 0.8 },
    );

    const r = await domainAnswer("質問", longHits, cloud);

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
