import { describe, it, expect } from "vitest";
import { InferenceError } from "../src/lib/inference";

// #6: errorCode を message 文字列マッチでなく kind/status から導く（観測・アラート分岐の入力）。
describe("InferenceError.errorCode: kind/status から正規化", () => {
  it("http は status をそのまま文字列化（429/5xx でアラート分岐可能）", () => {
    expect(new InferenceError("p", "rate limited", "http", 429).errorCode).toBe("429");
    expect(new InferenceError("p", "upstream down", "http", 503).errorCode).toBe("503");
  });

  it("http で status 未指定なら 'http' にフォールバック", () => {
    expect(new InferenceError("p", "no status", "http").errorCode).toBe("http");
  });

  it("http 以外の kind はそのまま errorCode になる", () => {
    expect(new InferenceError("p", "timed out", "timeout").errorCode).toBe("timeout");
    expect(new InferenceError("p", "refused", "connrefused").errorCode).toBe("connrefused");
    expect(new InferenceError("p", "empty", "empty").errorCode).toBe("empty");
    expect(new InferenceError("p", "bad", "badformat").errorCode).toBe("badformat");
    expect(new InferenceError("p", "no key", "config").errorCode).toBe("config");
  });

  it("message は [provider] 接頭辞付き、cause を保持できる", () => {
    const cause = new Error("socket hang up");
    const e = new InferenceError("opencode:test", "接続できません", "connrefused", undefined, cause);
    expect(e.message).toBe("[opencode:test] 接続できません");
    expect(e.cause).toBe(cause);
    expect(e.provider).toBe("opencode:test");
  });
});
