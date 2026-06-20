import { describe, it, expect } from "vitest";
import {
  queryRef,
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

describe("routingDecisionToRow: RoutingLogEntry → 行マッピング", () => {
  const base = {
    reqId: "req-1",
    ts: 1_700_000_000_000,
    queryRef: "deadbeefdeadbeef",
    versions: {
      embedModel: "bge-m3",
      classifierVersion: "v1",
      genModel: "ollama:gemma3:4b",
    },
    latencyMs: { embed: 12, gen: 980, total: 1010 },
  };

  it("classifier 経路 + edge served: stage1/stage2 が正しく落ちる", () => {
    const entry: RoutingLogEntry = {
      ...base,
      tier: "edge",
      stage1: {
        method: "classifier",
        score: -0.02,
        threshold: -0.0104,
        margin: -0.0096,
        simCloud: 0.41,
        simEdge: 0.43,
      },
      stage2: { edgeConfidence: 0.82, escalated: false, guardrailEscalated: false },
      served: "edge",
    };
    const row = routingDecisionToRow(entry);
    expect(row.method).toBe("classifier");
    expect(row.score).toBe(-0.02);
    expect(row.threshold).toBe(-0.0104);
    expect(row.margin).toBeCloseTo(-0.0096);
    expect(row.simCloud).toBe(0.41);
    expect(row.served).toBe("edge");
    expect(row.edgeConfidence).toBe(0.82);
    expect(row.escalated).toBe(false);
    expect(row.guardrailEsc).toBe(false);
    expect(row.genModel).toBe("ollama:gemma3:4b");
    expect(row.latencyTotal).toBe(1010);
    // ts は epoch ms → Date に変換。
    expect(row.ts).toBeInstanceOf(Date);
    expect((row.ts as Date).getTime()).toBe(1_700_000_000_000);
  });

  it("rule 経路（埋め込み不通）: score 系は null（DDL nullable の根拠）", () => {
    const entry: RoutingLogEntry = {
      ...base,
      tier: "cloud",
      stage1: {
        method: "rule",
        score: null,
        threshold: null,
        margin: null,
        simCloud: null,
        simEdge: null,
      },
      served: "cloud", // stage2 なし（段1で直 cloud）
    };
    const row = routingDecisionToRow(entry);
    expect(row.method).toBe("rule");
    expect(row.score).toBeNull();
    expect(row.threshold).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.simCloud).toBeNull();
    // stage2 不在 → escalation 系も null。
    expect(row.edgeConfidence).toBeNull();
    expect(row.escalated).toBeNull();
    expect(row.guardrailEsc).toBeNull();
    expect(row.served).toBe("cloud");
  });

  it("guardrail エスカレーション: served=cloud で guardrailEsc=true", () => {
    const entry: RoutingLogEntry = {
      ...base,
      tier: "edge", // 段1は edge と判定したが…
      stage1: {
        method: "classifier",
        score: -0.05,
        threshold: -0.0104,
        margin: -0.0396,
        simCloud: 0.38,
        simEdge: 0.43,
      },
      stage2: { edgeConfidence: 0.9, escalated: false, guardrailEscalated: true },
      served: "cloud", // ガードレールで cloud へ巻き戻し
    };
    const row = routingDecisionToRow(entry);
    expect(row.served).toBe("cloud");
    expect(row.guardrailEsc).toBe(true);
    expect(row.escalated).toBe(false);
  });
});
