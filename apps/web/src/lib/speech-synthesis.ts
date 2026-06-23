import { useState, useEffect, useRef } from "react";

// ──────────────────────────────────────────────────────────────────────────────
// ドライバーインターフェース
// SpeechSynthesis / SpeechSynthesisUtterance は TypeScript 5.x の lib.dom に存在する。
// テスト時にブラウザ API を偽装せず済むよう、操作を最小インターフェースで隔離する。
// ──────────────────────────────────────────────────────────────────────────────

/**
 * TTS 実装を呼び出し側から隔離するドライバーインターフェース。
 * テスト時はダミー実装を注入してブラウザ API の偽装を避ける。
 */
export interface SpeechSynthesisDriver {
  /** 指定テキストを読み上げる。再生が完了（または中断）したら onEnd を呼ぶ */
  speak(text: string, lang: string, onEnd: () => void): void;
  /** 現在の読み上げを中断する */
  cancel(): void;
}

// ──────────────────────────────────────────────────────────────────────────────
// 純粋関数（単体テスト対象）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * TTS トグル状態遷移の純粋ロジック。
 * 新しい speakingId と取るべきアクションを返す（副作用なし）。
 *
 * @param current - 現在の speakingId（再生中でなければ null）
 * @param id      - ボタンが押された回答 id
 */
export function toggleTtsState(
  current: string | null,
  id: string,
): { next: string | null; action: "start" | "stop" | "switch" } {
  if (current === id) {
    return { next: null, action: "stop" };
  }
  if (current !== null) {
    return { next: id, action: "switch" };
  }
  return { next: id, action: "start" };
}

// ──────────────────────────────────────────────────────────────────────────────
// TTS コントローラー（テスト可能な非 React ロジック）
// ──────────────────────────────────────────────────────────────────────────────

export interface TtsController {
  /** 指定 id の読み上げ再生/停止をトグルする。別 id の場合は前の再生を止めてから新規再生 */
  toggle(id: string, text: string): void;
  /** 全再生を停止する（ページ遷移・アンマウント時に使用） */
  cancel(): void;
  /** 現在の speakingId を返す（テスト用） */
  getSpeakingId(): string | null;
}

/**
 * TTS コントローラーを生成する。React に依存しないため単体テスト可能。
 * onSpeakingIdChange で状態変化を通知するので、React フックは setState で受ける。
 */
export function createTtsController(
  driver: SpeechSynthesisDriver,
  onSpeakingIdChange: (id: string | null) => void,
): TtsController {
  let speakingId: string | null = null;

  function update(id: string | null) {
    speakingId = id;
    onSpeakingIdChange(id);
  }

  return {
    toggle(id: string, text: string) {
      const { action, next } = toggleTtsState(speakingId, id);
      driver.cancel(); // 既存の再生を必ず停止してから
      if (action === "stop") {
        update(null);
      } else {
        // "start" または "switch": 新たに再生開始
        update(id);
        driver.speak(text, "ja-JP", () => {
          // 再生終了時に自分が まだ speakingId なら null に戻す
          if (speakingId === id) update(null);
        });
      }
      // next は action と一致するが念のため使用しない（上記 if で保証済み）
      void next;
    },

    cancel() {
      driver.cancel();
      update(null);
    },

    getSpeakingId() {
      return speakingId;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Web Speech Synthesis 実装（本番用ドライバーファクトリー）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ブラウザ組み込みの SpeechSynthesis を使って SpeechSynthesisDriver を生成する。
 * SSR 安全のため、window が存在する文脈から呼ぶこと。
 * 非対応ブラウザでは null を返す。
 */
export function createWebSpeechSynthesisDriver(): SpeechSynthesisDriver | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synth = window.speechSynthesis;

  return {
    speak(text: string, lang: string, onEnd: () => void) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 1.0;

      // ja-JP の既定音声を選択。取得できなければブラウザが自動選択する。
      const voices = synth.getVoices();
      const jaVoice = voices.find((v) => v.lang.startsWith("ja"));
      if (jaVoice) utterance.voice = jaVoice;

      utterance.onend = onEnd;
      utterance.onerror = onEnd; // エラー時も終了扱いにして speakingId をリセットする
      synth.speak(utterance);
    },

    cancel() {
      synth.cancel();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// フック（public API）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 回答読み上げ（TTS）フック。
 *
 * - 同時再生は1つ。別 id を toggle したら前の再生を自動停止する。
 * - ja-JP 既定音声・標準速度。音声設定 UI は持たない。
 * - ページ遷移・アンマウント時は cancel() でクリーンアップする。
 * - _driver でダミーを注入してテスト可能（フックのロジックは createTtsController に委譲）。
 */
export function useSpeechSynthesis(opts?: {
  /** テスト用注入ポイント。null を渡すと TTS 無効扱い */
  _driver?: SpeechSynthesisDriver | null;
}): {
  speakingId: string | null;
  toggle: (id: string, text: string) => void;
  cancel: () => void;
} {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const controllerRef = useRef<TtsController | null>(null);

  useEffect(() => {
    let driver: SpeechSynthesisDriver | null;

    if (opts && "_driver" in opts) {
      driver = opts._driver ?? null;
    } else {
      driver = createWebSpeechSynthesisDriver();
    }

    if (!driver) {
      // TTS 非対応ブラウザ: コントローラーなし（toggle は no-op になる）
      return;
    }

    controllerRef.current = createTtsController(driver, setSpeakingId);

    return () => {
      // アンマウント時: 読み上げ中断 + コントローラー破棄
      controllerRef.current?.cancel();
      controllerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, text: string) => {
    controllerRef.current?.toggle(id, text);
  };

  const cancel = () => {
    controllerRef.current?.cancel();
  };

  return { speakingId, toggle, cancel };
}
