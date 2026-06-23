import { describe, it, expect, vi } from "vitest";
import { toggleTtsState, createTtsController } from "./speech-synthesis";
import type { SpeechSynthesisDriver } from "./speech-synthesis";

// ──────────────────────────────────────────────────────────────────────────────
// toggleTtsState: TTS 状態遷移の純粋ロジック
// ──────────────────────────────────────────────────────────────────────────────

describe("toggleTtsState", () => {
  it("再生中でない状態で id1 を押したら start アクションで id1 になる", () => {
    const result = toggleTtsState(null, "id1");
    expect(result).toEqual({ next: "id1", action: "start" });
  });

  it("id1 再生中に同じ id1 を押したら stop アクションで null になる", () => {
    const result = toggleTtsState("id1", "id1");
    expect(result).toEqual({ next: null, action: "stop" });
  });

  it("id1 再生中に別の id2 を押したら switch アクションで id2 になる", () => {
    const result = toggleTtsState("id1", "id2");
    expect(result).toEqual({ next: "id2", action: "switch" });
  });

  it("再生中でない状態で stop を押しても stop アクションにはならない（start）", () => {
    const result = toggleTtsState(null, "id1");
    expect(result.action).toBe("start");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// createTtsController: ドライバー呼び出し順・speakingId 遷移の検証
// ──────────────────────────────────────────────────────────────────────────────

describe("createTtsController", () => {
  // ダミードライバーを生成するヘルパー
  function makeFakeDriver(): {
    driver: SpeechSynthesisDriver;
    calls: string[];
    triggerEnd(): void;
  } {
    const calls: string[] = [];
    let endCallback: (() => void) | null = null;

    const driver: SpeechSynthesisDriver = {
      speak: (text: string, _lang: string, onEnd: () => void) => {
        calls.push(`speak:${text}`);
        endCallback = onEnd;
      },
      cancel: () => {
        calls.push("cancel");
      },
    };

    return {
      driver,
      calls,
      triggerEnd: () => {
        endCallback?.();
        endCallback = null;
      },
    };
  }

  it("新規再生: cancel してから speak が呼ばれ speakingId が設定される", () => {
    const { driver, calls } = makeFakeDriver();
    const onSpeakingIdChange = vi.fn();
    const ctrl = createTtsController(driver, onSpeakingIdChange);

    ctrl.toggle("id1", "介護の話");

    expect(calls).toEqual(["cancel", "speak:介護の話"]);
    expect(ctrl.getSpeakingId()).toBe("id1");
    expect(onSpeakingIdChange).toHaveBeenCalledWith("id1");
  });

  it("同じ id を再押し: cancel のみで speakingId が null になる", () => {
    const { driver, calls } = makeFakeDriver();
    const onSpeakingIdChange = vi.fn();
    const ctrl = createTtsController(driver, onSpeakingIdChange);

    ctrl.toggle("id1", "テキスト");
    calls.length = 0;
    onSpeakingIdChange.mockClear();

    ctrl.toggle("id1", "テキスト"); // 同じ id → 停止

    expect(calls).toEqual(["cancel"]);
    expect(ctrl.getSpeakingId()).toBeNull();
    expect(onSpeakingIdChange).toHaveBeenCalledWith(null);
  });

  it("別 id 切替: cancel してから新規 speak が呼ばれる", () => {
    const { driver, calls } = makeFakeDriver();
    const onSpeakingIdChange = vi.fn();
    const ctrl = createTtsController(driver, onSpeakingIdChange);

    ctrl.toggle("id1", "最初の回答");
    calls.length = 0;
    onSpeakingIdChange.mockClear();

    ctrl.toggle("id2", "次の回答"); // 別 id → 切替

    expect(calls).toEqual(["cancel", "speak:次の回答"]);
    expect(ctrl.getSpeakingId()).toBe("id2");
    expect(onSpeakingIdChange).toHaveBeenLastCalledWith("id2");
  });

  it("読み上げが自然終了したら speakingId が null に戻る", () => {
    const { driver, triggerEnd } = makeFakeDriver();
    const onSpeakingIdChange = vi.fn();
    const ctrl = createTtsController(driver, onSpeakingIdChange);

    ctrl.toggle("id1", "読み上げテキスト");
    expect(ctrl.getSpeakingId()).toBe("id1");

    triggerEnd(); // 再生完了イベントを模擬

    expect(ctrl.getSpeakingId()).toBeNull();
    expect(onSpeakingIdChange).toHaveBeenLastCalledWith(null);
  });

  it("cancel(): 読み上げを中断して speakingId を null にする", () => {
    const { driver, calls } = makeFakeDriver();
    const onSpeakingIdChange = vi.fn();
    const ctrl = createTtsController(driver, onSpeakingIdChange);

    ctrl.toggle("id1", "テキスト");
    calls.length = 0;
    onSpeakingIdChange.mockClear();

    ctrl.cancel();

    expect(calls).toContain("cancel");
    expect(ctrl.getSpeakingId()).toBeNull();
    expect(onSpeakingIdChange).toHaveBeenCalledWith(null);
  });

  it("自然終了後に別 id を再生しても speakingId が正しく更新される", () => {
    const { driver, triggerEnd } = makeFakeDriver();
    const ctrl = createTtsController(driver, vi.fn());

    ctrl.toggle("id1", "一問目");
    triggerEnd();
    expect(ctrl.getSpeakingId()).toBeNull();

    ctrl.toggle("id2", "二問目");
    expect(ctrl.getSpeakingId()).toBe("id2");
  });
});
