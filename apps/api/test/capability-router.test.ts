import { describe, it, expect } from "vitest";
import {
  classifyRoute,
  buildSystemPrompt,
  KNOWLEDGE_QA_SYSTEM,
  ESCALATE_SYSTEM,
  CONSTANTS_TEXT,
} from "../src/lib/capability-router";
import type { InferProvider } from "../src/lib/inference";

// 分類器(cloud LLM)を固定応答に差し替えるfake。ネットワーク非依存で分類の解析/フォールバックを検証。
function fakeCloud(text: string): InferProvider {
  return {
    name: "fake",
    async infer() {
      return { text, confidence: 1 };
    },
  };
}

describe("classifyRoute: 介護QA の意図分類（JSON解析とフォールバック）", () => {
  it("escalate を含むJSONを escalate として解析する", async () => {
    const d = await classifyRoute(
      "母は要介護2です。毎月いくら払いますか",
      fakeCloud('{"route":"escalate","reason":"個別の金額算定"}'),
    );
    expect(d.route).toBe("escalate");
    expect(d.reason).toBe("個別の金額算定");
  });

  it("knowledge_qa を含むJSONを knowledge_qa として解析する", async () => {
    const d = await classifyRoute(
      "自己負担割合はどう決まりますか",
      fakeCloud('{"route":"knowledge_qa","reason":"制度説明"}'),
    );
    expect(d.route).toBe("knowledge_qa");
  });

  it("前置き付き応答でも埋め込まれたJSONを抽出する", async () => {
    const d = await classifyRoute(
      "x",
      fakeCloud('判定します。\n```json\n{"route":"escalate","reason":"r"}\n```'),
    );
    expect(d.route).toBe("escalate");
  });

  it("未知ラベルは安全側の knowledge_qa にフォールバックする", async () => {
    const d = await classifyRoute("x", fakeCloud('{"route":"calc","reason":"r"}'));
    expect(d.route).toBe("knowledge_qa");
  });

  it("JSONを含まない応答は knowledge_qa にフォールバックする", async () => {
    const d = await classifyRoute("x", fakeCloud("わかりません"));
    expect(d.route).toBe("knowledge_qa");
    expect(d.reason).toContain("解析");
  });

  it("reason は30字に丸める", async () => {
    const long = "あ".repeat(50);
    const d = await classifyRoute(
      "x",
      fakeCloud(`{"route":"knowledge_qa","reason":"${long}"}`),
    );
    expect(d.reason.length).toBe(30);
  });

  it("質問に $& 等が含まれても置換パターンと誤解釈せず逐語で埋め込む（#10 footgun）", async () => {
    let captured = "";
    const capturingCloud: InferProvider = {
      name: "fake",
      async infer(prompt: string) {
        captured = prompt;
        return { text: '{"route":"knowledge_qa","reason":"r"}', confidence: 1 };
      },
    };
    const tricky = "費用は $& $1 $` で計算しますか";
    await classifyRoute(tricky, capturingCloud);
    // String.replace の置換パターン($&等)に化けず、質問がそのまま現れる。
    expect(captured).toContain(tricky);
  });
});

describe("buildSystemPrompt: route に応じた生成ポリシーの切替", () => {
  const refs = ["要介護2の区分支給限度額は19,705単位/月", "デイサービスの単位数は提供時間で異なる"];

  it("knowledge_qa は V2(数値省略禁止) プロンプトを使い参考情報を埋め込む", () => {
    const p = buildSystemPrompt("knowledge_qa", refs);
    expect(p.startsWith(KNOWLEDGE_QA_SYSTEM)).toBe(true);
    expect(p).toContain(refs[0]);
    // escalate 専用の制度定数ブロックは含めない。
    expect(p).not.toContain(CONSTANTS_TEXT);
  });

  it("escalate は guardrail プロンプト + 確定制度定数 + 参考情報を埋め込む", () => {
    const p = buildSystemPrompt("escalate", refs);
    expect(p.startsWith(ESCALATE_SYSTEM)).toBe(true);
    expect(p).toContain(CONSTANTS_TEXT);
    expect(p).toContain(refs[1]);
  });

  it("確定制度定数は要介護3=27,048単位を含む（augmentation の実値確認）", () => {
    expect(CONSTANTS_TEXT).toContain("要介護3 27,048単位");
  });
});
