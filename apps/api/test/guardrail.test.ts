import { describe, it, expect } from "vitest";
import {
  detectRiskyAssertion,
  withDisclaimer,
  AI_DISCLAIMER,
} from "../src/lib/guardrail";

describe("detectRiskyAssertion: 医療/法令の断定検知（Layer2 ガードレール）", () => {
  // --- 医療アドバイスの断定（検知して cloud へ倒すべき）---
  it.each([
    ["診断の断定", "症状から判断すると関節リウマチと診断します。", "medical:diagnosis"],
    ["投薬の指示", "痛み止めを服用してください。", "medical:medication"],
    ["治癒の断定", "この体操を続ければ必ず治ります。", "medical:cure"],
    ["受診不要の断定", "この程度なら受診は不要です。", "medical:dismiss"],
    ["違法性の断定", "その契約は違法です。", "legal:legality"],
    ["罰則の断定", "申請しないと罰則があります。", "legal:penalty"],
    ["法的義務の断定", "法律上必ず提出しなければなりません。", "legal:obligation"],
  ])("%s を risky として検知し理由を返す", (_name, text, reason) => {
    const r = detectRiskyAssertion(text);
    expect(r.risky).toBe(true);
    expect(r.reasons).toContain(reason);
  });

  // --- 事実説明・一般応答（誤検知してはいけない＝過剰エスカレ防止）---
  it.each([
    ["サービス概要の事実説明", "デイサービスは日帰りで介護や機能訓練を受けられるサービスです。"],
    ["制度上の義務の事実説明", "サービス担当者会議には開催義務があります。"],
    ["挨拶", "こんにちは。本日はよろしくお願いします。"],
    ["一般的な持ち物案内", "持ち物はタオルと着替えをご用意ください。"],
  ])("%s は risky としない", (_name, text) => {
    const r = detectRiskyAssertion(text);
    expect(r.risky).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("空文字は risky としない（異常値）", () => {
    expect(detectRiskyAssertion("")).toEqual({ risky: false, reasons: [] });
  });

  it("複数の断定を含む場合は理由を重複なく列挙する", () => {
    const r = detectRiskyAssertion(
      "リウマチと診断します。さらに痛み止めを服用してください。",
    );
    expect(r.risky).toBe(true);
    expect(r.reasons).toEqual(
      expect.arrayContaining(["medical:diagnosis", "medical:medication"]),
    );
    // 重複排除（同一 reason は1つ）。
    expect(new Set(r.reasons).size).toBe(r.reasons.length);
  });
});

describe("withDisclaimer: 免責文の常時付与", () => {
  it("免責文がなければ末尾に1つ付与する", () => {
    const out = withDisclaimer("要介護認定の流れを説明します。");
    expect(out.endsWith(AI_DISCLAIMER)).toBe(true);
    expect(out).toContain("要介護認定の流れを説明します。");
  });

  it("既に免責文を含む場合は二重付与しない（冪等）", () => {
    const once = withDisclaimer("回答本文です。");
    const twice = withDisclaimer(once);
    expect(twice).toBe(once);
    const count = twice.split(AI_DISCLAIMER).length - 1;
    expect(count).toBe(1);
  });

  it("末尾の余分な空白を整理してから付与する", () => {
    const out = withDisclaimer("本文です。   \n\n  ");
    expect(out).toBe(`本文です。\n\n${AI_DISCLAIMER}`);
  });
});
