import { describe, it, expect } from "vitest";
import { checkGrounding } from "../src/lib/grounding";
import type { InferProvider } from "../src/lib/inference";

function fakeCloud(text: string, throws = false): InferProvider {
  return {
    name: "fake:cloud",
    async infer() {
      if (throws) throw new Error("LLM unavailable");
      return { text, confidence: 1 };
    },
  };
}

const QUESTION = "令和6年改定後の訪問介護の基本報酬単位数は？";
const ANSWER = "令和6年改定後の訪問介護の基本報酬は引き下げられました。";
const CHUNKS = ["訪問介護の令和6年改定後の基本報酬については事務連絡参照。"];

describe("checkGrounding: LLM grounding チェック（④）", () => {
  it("GROUNDED → true", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("GROUNDED"));
    expect(result).toBe(true);
  });

  it("UNGROUNDED → false", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("UNGROUNDED"));
    expect(result).toBe(false);
  });

  it("余分なテキスト付きで GROUNDED を含む → true", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("この回答はGROUNDEDです。"));
    expect(result).toBe(true);
  });

  it("余分なテキスト付きで UNGROUNDED を含む → false（UNGROUNDEDが優先）", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("判定: UNGROUNDED（根拠なし）"));
    expect(result).toBe(false);
  });

  it("LLM エラー → fail-open（true を返す）", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("", true));
    expect(result).toBe(true);
  });

  it("空応答 → 曖昧だが UNGROUNDED を含まないため true（fail-open）", async () => {
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud(""));
    expect(result).toBe(true);
  });

  it("chunks は最大5件だけ渡す（slice 確認）", async () => {
    let capturedPrompt = "";
    const capturingCloud: InferProvider = {
      name: "fake:capture",
      async infer(prompt) {
        capturedPrompt = prompt;
        return { text: "GROUNDED", confidence: 1 };
      },
    };
    const manyChunks = Array.from({ length: 10 }, (_, i) => `chunk-${i}`);
    await checkGrounding(QUESTION, ANSWER, manyChunks, capturingCloud);
    // chunk-5 以降は含まれない
    expect(capturedPrompt).toContain("chunk-4");
    expect(capturedPrompt).not.toContain("chunk-5");
  });
});

describe("checkGrounding: knowledge_qa grounding 失敗シナリオ", () => {
  it("grounded=false の時 domainAnswer が abstain を返す", async () => {
    // grounding.test.ts は checkGrounding 単体のみ検証。
    // domainAnswer 統合は ai-qa.test.ts の grounding 失敗テストで担保する。
    const result = await checkGrounding(QUESTION, ANSWER, CHUNKS, fakeCloud("UNGROUNDED"));
    expect(result).toBe(false);
  });
});
