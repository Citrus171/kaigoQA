import { describe, it, expect } from "vitest";
import {
  appendText,
  detectSpeechRecognitionStatus,
  isTerminalRecognitionError,
} from "./speech-recognition";

// ──────────────────────────────────────────────────────────────────────────────
// appendText: 確定テキスト追記ロジック
// ──────────────────────────────────────────────────────────────────────────────

describe("appendText", () => {
  it("既存テキストがない場合はトリム済みの確定テキストをそのまま返す", () => {
    expect(appendText("", "今日の天気は")).toBe("今日の天気は");
  });

  it("確定テキストが空（空文字）なら既存テキストをそのまま返す", () => {
    expect(appendText("既存テキスト", "")).toBe("既存テキスト");
  });

  it("確定テキストがスペースのみなら既存テキストをそのまま返す", () => {
    expect(appendText("既存テキスト", "   ")).toBe("既存テキスト");
  });

  it("既存テキストの末尾にスペースがない場合はスペース区切りで追記する", () => {
    expect(appendText("薬の飲み方", "教えてください")).toBe("薬の飲み方 教えてください");
  });

  it("既存テキストの末尾にスペースがある場合は区切りスペースを追加しない", () => {
    expect(appendText("薬の飲み方 ", "教えてください")).toBe("薬の飲み方 教えてください");
  });

  it("既存テキストの末尾が改行の場合もスペースなしで追記する", () => {
    expect(appendText("一行目\n", "二行目")).toBe("一行目\n二行目");
  });

  it("連続発話: 2回目の追記も正しく区切られる", () => {
    const first = appendText("", "今日の");
    const second = appendText(first, "天気は");
    expect(second).toBe("今日の 天気は");
  });

  it("確定テキストの前後の空白はトリムして追記する", () => {
    expect(appendText("既存", "  追記テキスト  ")).toBe("既存 追記テキスト");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// detectSpeechRecognitionStatus: フォールバック判定ロジック
// ──────────────────────────────────────────────────────────────────────────────

describe("detectSpeechRecognitionStatus", () => {
  it("SpeechRecognition が存在しない場合は ok:false（非対応ブラウザ）", () => {
    const result = detectSpeechRecognitionStatus({
      hasSpeechRecognition: false,
      isSecureContext: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Chrome/Edge");
    }
  });

  it("非 secure context（http の localhost 以外）の場合は ok:false", () => {
    const result = detectSpeechRecognitionStatus({
      hasSpeechRecognition: true,
      isSecureContext: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("HTTPS");
    }
  });

  it("SpeechRecognition あり + secure context なら ok:true", () => {
    const result = detectSpeechRecognitionStatus({
      hasSpeechRecognition: true,
      isSecureContext: true,
    });
    expect(result.ok).toBe(true);
  });

  it("SpeechRecognition なし + 非 secure context は ok:false（非対応が優先）", () => {
    const result = detectSpeechRecognitionStatus({
      hasSpeechRecognition: false,
      isSecureContext: false,
    });
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isTerminalRecognitionError: エラー時にドライバーを破棄すべきか
// 回帰: 一時的エラー（"other"）で破棄すると2回目以降マイクが反応しなくなるバグ
// ──────────────────────────────────────────────────────────────────────────────

describe("isTerminalRecognitionError", () => {
  it("denied（権限拒否）は終端＝ドライバー破棄", () => {
    expect(isTerminalRecognitionError("denied")).toBe(true);
  });

  it("other（no-speech / aborted / network 等）は終端でない＝ドライバー保持し再利用可能", () => {
    // false でなければ、1度目の発話後の transient error でマイクが死ぬ回帰が再発する
    expect(isTerminalRecognitionError("other")).toBe(false);
  });
});
