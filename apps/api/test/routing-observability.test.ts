import { describe, it, expect } from "vitest";
import {
  queryRef,
  answerRef,
  routingDecisionToRow,
  type RoutingLogEntry,
} from "../src/lib/routing-observability";

describe("queryRef: PII 非保持の query 参照（sha256 先端）", () => {
  it("同一入力は決定的に同じ参照を返す", async () => {
    const a = await queryRef("要介護2でデイサービスは何回使えますか");
    const b = await queryRef("要介護2でデイサービスは何回使えますか");
    expect(a).toBe(b);
  });

  it("16桁の16進（8バイト）で、原文を復元できない", async () => {
    const ref = await queryRef("田中花子さんの認知症について");
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    // 原文の断片を含まない（PII 漏洩しない）。
    expect(ref).not.toContain("田中");
  });

  it("異なる入力は異なる参照になる", async () => {
    const a = await queryRef("こんにちは");
    const b = await queryRef("こんばんは");
    expect(a).not.toBe(b);
  });
});

describe("answerRef: PII 非保持の回答参照（sha256 先端）", () => {
  it("同一回答は同一参照。原文非復元", async () => {
    const a = await answerRef("市区町村の窓口で申請してください。MSWにご相談を。");
    const b = await answerRef("市区町村の窓口で申請してください。MSWにご相談を。");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("市区町村");
  });

  it("異なる回答は異なる参照", async () => {
    const a = await answerRef("回答A");
    const b = await answerRef("回答B");
    expect(a).not.toBe(b);
  });
});

describe("routingDecisionToRow: RoutingLogEntry → 行マッピング", () => {
  const base = {
    reqId: "req-1",
    ts: 1_700_000_000_000,
    queryRef: "deadbeefdeadbeef",
    versions: {
      classifierVersion: "opencode-go:deepseek-v4-flash",
      genModel: "workersai:@cf/google/gemma-4-26b-a4b-it",
    },
    latencyMs: { gen: 980, total: 1300 },
  };

  it("ドメイン内 knowledge_qa + edge served: retrieval/stage1/stage2 が正しく落ちる", () => {
    const entry: RoutingLogEntry = {
      ...base,
      retrieval: {
        topScore: 0.758,
        domain: "in",
        retrieved: [
          { srcId: "gold-A-037", score: 0.758 },
          { srcId: "gold-A-060", score: 0.705 },
          { srcId: "gold-A-045", score: 0.704 },
        ],
        latencyEmbed: 320,
        embedModel: "cf:@cf/baai/bge-m3",
      },
      stage1: {
        method: "llm",
        route: "knowledge_qa",
        routeReason: "制度説明のため参考知識で回答可能",
        classifierVersion: "opencode-go:deepseek-v4-flash",
      },
      stage2: { edgeConfidence: 0.7, escalated: false, guardrailEscalated: false },
      served: "edge",
      answerRef: "cafebabecafebabe",
      errorCode: null,
    };
    const row = routingDecisionToRow(entry);
    // 段0 RAG
    expect(row.topScore).toBe(0.758);
    expect(row.domain).toBe("in");
    // jsonb 列は配列のまま保持（文字列化しない）。
    expect(row.retrievedSrcIds).toEqual(["gold-A-037", "gold-A-060", "gold-A-045"]);
    expect(row.retrievedScores).toEqual([0.758, 0.705, 0.704]);
    // 段1 LLM 分類（score/margin/sim は現在 null）
    expect(row.method).toBe("llm");
    expect(row.route).toBe("knowledge_qa");
    expect(row.routeReason).toBe("制度説明のため参考知識で回答可能");
    expect(row.score).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.simCloud).toBeNull();
    // 段2 cascade
    expect(row.served).toBe("edge");
    expect(row.edgeConfidence).toBe(0.7);
    expect(row.escalated).toBe(false);
    expect(row.guardrailEsc).toBe(false);
    // 出力・エラー
    expect(row.answerRef).toBe("cafebabecafebabe");
    expect(row.errorCode).toBeNull();
    // versions/latency（embedModel/latencyEmbed は retrieval が single source）
    expect(row.genModel).toBe("workersai:@cf/google/gemma-4-26b-a4b-it");
    expect(row.embedModel).toBe("cf:@cf/baai/bge-m3");
    expect(row.latencyEmbed).toBe(320);
    expect(row.latencyGen).toBe(980);
    expect(row.latencyTotal).toBe(1300);
    // ts は epoch ms → Date に変換。
    expect(row.ts).toBeInstanceOf(Date);
    expect((row.ts as Date).getTime()).toBe(1_700_000_000_000);
  });

  it("ドメイン外 general: stage1 未実行（null）。served は cascade で決定", () => {
    const entry: RoutingLogEntry = {
      ...base,
      retrieval: {
        topScore: 0.39,
        domain: "out",
        retrieved: [{ srcId: "gold-A-012", score: 0.39 }],
        latencyEmbed: 280,
        embedModel: "cf:@cf/baai/bge-m3",
      },
      // general は段1未実行 → stage1 なし
      stage2: { edgeConfidence: 0.7, escalated: false, guardrailEscalated: false },
      served: "edge",
      answerRef: "abcdef0123456789",
      errorCode: null,
    };
    const row = routingDecisionToRow(entry);
    expect(row.domain).toBe("out");
    expect(row.topScore).toBe(0.39);
    expect(row.method).toBeNull();
    expect(row.route).toBeNull();
    expect(row.routeReason).toBeNull();
    expect(row.served).toBe("edge");
    expect(row.answerRef).toBe("abcdef0123456789");
    expect(row.errorCode).toBeNull();
  });

  it("エラー時: served/answerRef null, errorCode 設定, 段1/段2 なし", () => {
    const entry: RoutingLogEntry = {
      ...base,
      retrieval: {
        topScore: 0,
        domain: "out",
        retrieved: [],
        latencyEmbed: 50,
        embedModel: "cf:@cf/baai/bge-m3",
      },
      served: null,
      answerRef: null,
      errorCode: "429",
      // エラー時は latency が embed 途中で止まりうる
    };
    const row = routingDecisionToRow(entry);
    expect(row.errorCode).toBe("429");
    expect(row.served).toBeNull();
    expect(row.answerRef).toBeNull();
    expect(row.method).toBeNull();
    expect(row.edgeConfidence).toBeNull();
    expect(row.escalated).toBeNull();
    expect(row.guardrailEsc).toBeNull();
    expect(row.latencyTotal).toBe(1300);
  });

  it("guardrail エスカレーション: served=cloud で guardrailEsc=true", () => {
    const entry: RoutingLogEntry = {
      ...base,
      retrieval: {
        topScore: 0.71,
        domain: "in",
        retrieved: [{ srcId: "gold-A-037", score: 0.71 }],
        latencyEmbed: 300,
        embedModel: "cf:@cf/baai/bge-m3",
      },
      stage1: {
        method: "llm",
        route: "escalate",
        routeReason: "個別ケースの数値結果",
        classifierVersion: "opencode-go:deepseek-v4-flash",
      },
      stage2: { edgeConfidence: 0.8, escalated: false, guardrailEscalated: true },
      served: "cloud", // ガードレールで cloud へ巻き戻し
      answerRef: "1122334455667788",
      errorCode: null,
    };
    const row = routingDecisionToRow(entry);
    expect(row.served).toBe("cloud");
    expect(row.guardrailEsc).toBe(true);
    expect(row.escalated).toBe(false);
    expect(row.route).toBe("escalate");
  });
});
