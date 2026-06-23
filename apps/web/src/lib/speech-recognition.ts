import { useState, useEffect, useRef } from "react";

// ──────────────────────────────────────────────────────────────────────────────
// 型宣言
// SpeechRecognitionResult / SpeechRecognitionResultList / SpeechRecognitionAlternative は
// TypeScript 5.x の lib.dom に存在するが、SpeechRecognition インターフェース本体と
// SpeechRecognitionEvent / SpeechRecognitionErrorEvent は存在しないため最小定義する。
// ──────────────────────────────────────────────────────────────────────────────

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInterface extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInterface;

// ──────────────────────────────────────────────────────────────────────────────
// フェーズ2（Whisper 等）への差し替えポイント
// ──────────────────────────────────────────────────────────────────────────────

/**
 * STT 実装を呼び出し側から隔離するドライバーインターフェース。
 * フェーズ2 で Whisper コンテナ等に差し替える際はこのインターフェースを実装した
 * ドライバーを返す factory を差し替えるだけで、chat/page.tsx 側は無改修で済む。
 */
export interface SpeechRecognitionDriver {
  start(): void;
  stop(): void;
  onFinalText(cb: (text: string) => void): void;
  onInterimText(cb: (text: string) => void): void;
  onError(cb: (reason: "denied" | "other") => void): void;
  onEnd(cb: () => void): void;
}

// ──────────────────────────────────────────────────────────────────────────────
// 純粋関数（単体テスト対象）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 既存テキストの末尾に確定テキストを追記する。
 * 手打ちと音声の併用を考慮し、末尾のスペース・改行を見て区切り文字を決める。
 */
export function appendText(existing: string, final: string): string {
  const trimmed = final.trim();
  if (!trimmed) return existing;
  if (!existing) return trimmed;
  // 末尾がスペース・改行でなければ区切りスペースを挿入
  const sep = /\s$/.test(existing) ? "" : " ";
  return existing + sep + trimmed;
}

/**
 * 音声入力サポート状況を検知する。
 * window に直接依存せず、環境情報を引数として受け取るため単体テスト可能。
 *
 * @param env - 検知対象の環境情報（本番では window から取得、テストはダミーを渡す）
 */
export function detectSpeechRecognitionStatus(env: {
  hasSpeechRecognition: boolean;
  isSecureContext: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!env.hasSpeechRecognition) {
    return {
      ok: false,
      reason:
        "このブラウザは音声入力に対応していません（Chrome/Edge を使用してください）",
    };
  }
  if (!env.isSecureContext) {
    return {
      ok: false,
      reason: "音声入力には HTTPS または localhost が必要です",
    };
  }
  return { ok: true };
}

/**
 * 認識エラーが「終端（=ドライバー破棄して回復不能）」か判定する。
 * - "denied"（権限拒否）のみ終端。再開してもブラウザが許可しないため破棄する。
 * - "other"（no-speech / aborted / network 等）は一時的。ドライバーは再利用でき、
 *   破棄すると start() が no-op 化して2回目以降マイクが反応しなくなる。
 */
export function isTerminalRecognitionError(reason: "denied" | "other"): boolean {
  return reason === "denied";
}

// ──────────────────────────────────────────────────────────────────────────────
// Web Speech API 実装（本番用ドライバーファクトリー）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ブラウザ組み込みの Web Speech API を使って SpeechRecognitionDriver を生成する。
 * SSR 安全のため、window が存在する文脈から呼ぶこと。
 * 非対応ブラウザでは null を返す。
 */
export function createWebSpeechDriver(lang: string): SpeechRecognitionDriver | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;

  let finalCb: ((text: string) => void) | null = null;
  let interimCb: ((text: string) => void) | null = null;
  let errorCb: ((reason: "denied" | "other") => void) | null = null;
  let endCb: (() => void) | null = null;

  rec.onresult = (ev: SpeechRecognitionEvent) => {
    let finalText = "";
    let interimText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }
    if (finalText) finalCb?.(finalText);
    interimCb?.(interimText);
  };

  rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
    errorCb?.(ev.error === "not-allowed" ? "denied" : "other");
  };

  rec.onend = () => {
    endCb?.();
  };

  return {
    start: () => rec.start(),
    stop: () => rec.stop(),
    onFinalText: (cb) => {
      finalCb = cb;
    },
    onInterimText: (cb) => {
      interimCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    onEnd: (cb) => {
      endCb = cb;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// フック（public API）
// ──────────────────────────────────────────────────────────────────────────────

// 無音タイムアウト等でユーザーの意図せず認識が停止したときの案内文。
// フェーズ1 は自動再開しない（Web Speech の再開は実 Chrome で数十秒の遅延があり実用にならない）。
// 認識済みテキストは textarea に残るので、ユーザーはマイクを再度押して続行する。
// 滑らかな連続口述はフェーズ2（faster-whisper）で対応する。
export const AUTO_STOP_NOTICE =
  "音声入力が停止しました。続けるにはマイクボタンをもう一度押してください。";

export type SpeechRecognitionState =
  | { status: "unsupported"; reason: string }
  | { status: "denied"; reason: string }
  // notice: 無音タイムアウト等で自動停止したときの案内（ユーザー停止時は undefined）
  | { status: "idle"; notice?: string }
  | { status: "listening"; interim: string };

/**
 * 音声入力（STT）フック。
 *
 * - ja-JP / continuous + interimResults で連続認識。
 * - 確定テキストは onFinalText コールバックで通知（呼び出し側が textarea に追記）。
 * - 途中経過は state.interim で公開（textarea には入れない）。
 * - 非対応・権限拒否・非 secure context は state.status で判別できる。
 * - フェーズ2 では _driver に Whisper 等のドライバーを注入して差し替える。
 *
 * @param opts._driver - テスト/フェーズ2 用注入ポイント。省略時は Web Speech API を使用。
 *                       null を渡すと「非対応」として扱う。
 */
export function useSpeechRecognition(opts: {
  lang?: string;
  onFinalText: (text: string) => void;
  /** テスト・フェーズ2 用。省略時は Web Speech API、null で「非対応」扱い */
  _driver?: SpeechRecognitionDriver | null;
}): {
  state: SpeechRecognitionState;
  start: () => void;
  stop: () => void;
} {
  const lang = opts.lang ?? "ja-JP";
  // マウント前（SSR 含む）は idle を初期値にして hydration mismatch を防ぐ。
  // unsupported/denied の検知は useEffect（クライアント側）で行う。
  const [state, setState] = useState<SpeechRecognitionState>({ status: "idle" });
  const driverRef = useRef<SpeechRecognitionDriver | null>(null);
  // onFinalText は render ごとに変わりうるので ref で保持して古い参照を回避する
  const onFinalTextRef = useRef(opts.onFinalText);
  onFinalTextRef.current = opts.onFinalText;

  /** ユーザーが明示的に stop() を呼んだか。onEnd で「案内を出すか（自動停止）/出さないか（ユーザー停止）」を分ける */
  const intentRef = useRef(false);
  /** 直前の onError が denied だったか。onEnd で denied を上書きしないために参照する */
  const deniedRef = useRef(false);
  /** アンマウント済みフラグ。クリーンアップ後のコールバック呼出を防ぐ */
  const unmountedRef = useRef(false);

  useEffect(() => {
    let driver: SpeechRecognitionDriver | null;

    if ("_driver" in opts) {
      // 注入ドライバーがある場合はそのまま使用（テスト・フェーズ2 用）
      driver = opts._driver ?? null;
      if (!driver) {
        setState({
          status: "unsupported",
          reason: "音声入力ドライバーが提供されていません",
        });
        return;
      }
    } else {
      // 本番: ブラウザ環境を検知してドライバーを生成
      const detection = detectSpeechRecognitionStatus({
        hasSpeechRecognition:
          "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
        isSecureContext: window.isSecureContext,
      });
      if (!detection.ok) {
        setState({ status: "unsupported", reason: detection.reason });
        return;
      }
      driver = createWebSpeechDriver(lang);
      if (!driver) {
        setState({
          status: "unsupported",
          reason:
            "このブラウザは音声入力に対応していません（Chrome/Edge を使用してください）",
        });
        return;
      }
    }

    driverRef.current = driver;

    driver.onFinalText((text) => {
      onFinalTextRef.current(text);
    });
    driver.onInterimText((text) => {
      setState((prev) =>
        prev.status === "listening" ? { status: "listening", interim: text } : prev,
      );
    });
    driver.onError((reason) => {
      if (isTerminalRecognitionError(reason)) {
        // 権限拒否は終端。ドライバーを破棄して denied 表示。
        deniedRef.current = true;
        driverRef.current = null;
        setState({ status: "denied", reason: "マイクへのアクセスが拒否されました" });
      }
      // no-speech / aborted / network 等の一時的エラーはドライバーを破棄しない
      // （破棄すると start() が no-op になり2回目以降反応しなくなる）。
      // 状態遷移は後続の onEnd に委ねる。
    });
    driver.onEnd(() => {
      // アンマウント後は無視（React 外のコールバックが遅延して届く場合）
      if (unmountedRef.current) return;
      // denied は onError で確定済み。onEnd で idle に戻して上書きしない。
      if (deniedRef.current) return;
      // 自動再開はしない。ユーザー停止なら無言で idle、
      // 無音タイムアウト等の意図しない停止なら案内を出して再タップを促す。
      // 認識済みテキストは textarea に残っているため失われない。
      setState({
        status: "idle",
        notice: intentRef.current ? undefined : AUTO_STOP_NOTICE,
      });
    });

    return () => {
      // アンマウント時: 参照を切る（以降のコールバックは unmountedRef で除外）
      unmountedRef.current = true;
      driverRef.current = null;
    };
    // lang は初期化時にのみ使用する（変更時の再初期化は不要）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => {
    const driver = driverRef.current;
    if (!driver) return;
    // ユーザーが明示的に開始: 停止フラグをリセットしてから開始
    intentRef.current = false;
    setState({ status: "listening", interim: "" });
    try {
      driver.start();
    } catch {
      // 既に認識中の InvalidStateError 等は無害（listening 表示のまま継続）
    }
  };

  const stop = () => {
    const driver = driverRef.current;
    if (!driver) return;
    // ユーザー停止フラグを立てる（onEnd で案内を出さない＝無言で idle）
    intentRef.current = true;
    // onend でも idle に戻るが、先行更新で即時 UI 反映する
    setState({ status: "idle" });
    driver.stop();
  };

  return { state, start, stop };
}
