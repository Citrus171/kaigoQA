"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, appendText } from "@/lib/speech-recognition";
import { useSpeechSynthesis } from "@/lib/speech-synthesis";
import type { AiQaAnswer } from "@hybrid/shared";

// localStorage 保存上限。要件: 過去20件。
const HISTORY_LIMIT = 20;
const HISTORY_KEY = "chat_history";

type HistoryItem = {
  id: string;
  question: string;
  answer: AiQaAnswer;
  createdAt: string;
};

function loadHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 要素の構造を検証。旧スキーマ/破損データはレンダリング時 TypeError を防ぐため破棄。
    return parsed.filter(
      (x): x is HistoryItem =>
        x !== null &&
        typeof x === "object" &&
        typeof (x as HistoryItem).id === "string" &&
        typeof (x as HistoryItem).question === "string" &&
        typeof (x as HistoryItem).createdAt === "string" &&
        (x as HistoryItem).answer !== null &&
        typeof (x as HistoryItem).answer === "object" &&
        typeof (x as HistoryItem).answer.answer === "string",
    );
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryItem[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

// secure context(localhost/HTTPS)以外でも一意IDを生成できるフォールバック付き。
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ChatPage() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [ready, setReady] = useState(false);

  // latest は history[0] の派生。二重 state の同期漏れを防ぐため単一ソースに集約。
  const latest = history[0] ?? null;

  // 音声入力（STT）フック。確定テキストを textarea の末尾に追記する。
  const stt = useSpeechRecognition({
    lang: "ja-JP",
    onFinalText: (text) => {
      setQuestion((prev) => appendText(prev, text));
    },
  });

  // 回答読み上げ（TTS）フック。同時再生は1つ。
  const tts = useSpeechSynthesis();

  // 初回マウントで履歴読み込み。
  useEffect(() => {
    const items = loadHistory();
    setHistory(items);
    setReady(true);
  }, []);

  // ページ離脱時に読み上げを停止する。
  useEffect(() => {
    return () => {
      tts.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed === "" || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // BFF プロキシ経由で JWT 自動添付。401 なら /login へ。
      const res = await api.ai.qa.$post({ json: { question: trimmed } });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(body?.message ?? `エラーが発生しました (HTTP ${res.status})`);
        return;
      }
      const answer = (await res.json()) as AiQaAnswer;
      const item: HistoryItem = {
        id: newId(),
        question: trimmed,
        answer,
        createdAt: new Date().toISOString(),
      };
      const next = [item, ...loadHistory()].slice(0, HISTORY_LIMIT);
      saveHistory(next);
      setHistory(next);
      setQuestion("");
    } catch {
      setError("通信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) return null;

  // マイクボタンの表示ラベル・無効状態を STT の状態に応じて決定する
  const micDisabled =
    stt.state.status === "unsupported" || stt.state.status === "denied";
  const micActive = stt.state.status === "listening";
  const micLabel = micActive ? "■ 停止" : "🎤 音声入力";
  const micTitle =
    stt.state.status === "unsupported" || stt.state.status === "denied"
      ? stt.state.reason
      : micActive
        ? "音声入力を停止"
        : "音声入力を開始";
  // 無音タイムアウト等で自動停止したときの案内（ユーザー停止時は出ない）
  const micNotice =
    stt.state.status === "idle" ? stt.state.notice : undefined;

  return (
    <main className="mx-auto mt-16 max-w-2xl px-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">介護サービス AI Q&amp;A</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            saveHistory([]);
            setHistory([]);
          }}
        >
          履歴クリア
        </Button>
      </header>

      <form onSubmit={onSubmit} className="space-y-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="質問を入力してください（最大4000文字）"
          maxLength={4000}
          rows={5}
          className="w-full rounded-md border border-neutral-300 bg-white p-3 text-sm shadow-sm placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={submitting}
        />

        {/* 音声入力コントロール */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant={micActive ? "destructive" : "outline"}
            size="sm"
            disabled={micDisabled || submitting}
            title={micTitle}
            onClick={() => {
              if (micActive) {
                stt.stop();
              } else {
                stt.start();
              }
            }}
          >
            {micLabel}
          </Button>

          {/* 途中経過プレビュー（textarea には入れない）。status で絞って型を確定させる */}
          {stt.state.status === "listening" && stt.state.interim && (
            <span className="text-sm text-neutral-400 italic">
              {stt.state.interim}
            </span>
          )}

          {/* 非対応・権限拒否時の理由表示 */}
          {(stt.state.status === "unsupported" ||
            stt.state.status === "denied") && (
            <span className="text-xs text-neutral-500">
              {stt.state.reason}
            </span>
          )}

          {/* 無音タイムアウト等で自動停止したときの案内（再タップ促し） */}
          {micNotice && (
            <span className="text-xs text-amber-600">{micNotice}</span>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={submitting || question.trim() === ""}>
          {submitting ? "送信中..." : "送信"}
        </Button>
      </form>

      <div className="mt-4 space-y-2">
        <p className="text-xs text-neutral-500">質問例</p>
        {[
          "本体施設である介護老人福祉施設と併設のショートステイについて、一体的に加算を算定できるのか。",
          "養護老人ホームの入所者が小規模多機能型居宅介護を利用することはできるか。",
          "施設サービスや短期入所サービスの入所（入院）日や退所（退院）日に通所サービスを算定できるか。",
        ].map((q) => (
          <button
            key={q}
            type="button"
            disabled={submitting}
            onClick={() => setQuestion(q)}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          >
            <span>{q}</span>
            <span className="shrink-0 text-neutral-400">⇒</span>
          </button>
        ))}
      </div>

      {latest && (
        <section className="mt-8 space-y-3">
          <h2 className="text-lg font-semibold">回答</h2>
          <AnswerView item={latest} speakingId={tts.speakingId} onToggleTts={tts.toggle} />
        </section>
      )}

      {history.length > 0 && (
        <section className="mt-10 space-y-3">
          <h2 className="text-lg font-semibold">
            過去の履歴（最新{history.length}件）
          </h2>
          <ul className="space-y-4">
            {history.map((item) => (
              <li key={item.id} className="rounded-md border border-neutral-200 p-4">
                <AnswerView
                  item={item}
                  speakingId={tts.speakingId}
                  onToggleTts={tts.toggle}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// 回答 + 補助情報を全て表示するビュー。読み上げトグルボタン付き。
function AnswerView({
  item,
  speakingId,
  onToggleTts,
}: {
  item: HistoryItem;
  speakingId: string | null;
  onToggleTts: (id: string, text: string) => void;
}) {
  const { answer } = item;
  const isPlaying = speakingId === item.id;

  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-medium text-neutral-600">質問</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{item.question}</p>
      </div>
      <div>
        {/* 読み上げトグルボタン: 回答見出し付近に配置 */}
        <div className="flex items-center gap-2">
          <p className="font-medium text-neutral-600">回答</p>
          <button
            type="button"
            onClick={() => onToggleTts(item.id, answer.answer)}
            title={isPlaying ? "読み上げを停止" : "回答を読み上げる"}
            className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 transition-colors"
          >
            {isPlaying ? "⏹ 停止" : "▶ 読み上げ"}
          </button>
        </div>
        <p data-testid="answer-text" className="mt-1 whitespace-pre-wrap break-words">{answer.answer}</p>
      </div>
      <div className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-700">
        <Row label="tier" value={answer.tier} />
        <Row label="route" value={answer.route} />
        <Row label="routeReason" value={answer.routeReason} />
        <Row label="confidence" value={answer.confidence.toFixed(3)} />
        <Row label="model" value={answer.model} />
        <Row label="topScore" value={answer.topScore.toFixed(3)} />
        <Row label="latencyMs" value={`${answer.latencyMs} ms`} />
        <Row
          label="safety.disclaimer"
          value={String(answer.safety.disclaimer)}
        />
        <Row
          label="safety.escalatedByGuardrail"
          value={String(answer.safety.escalatedByGuardrail)}
        />
        <Row
          label="safety.reasons"
          value={
            answer.safety.reasons.length > 0
              ? answer.safety.reasons.join("; ")
              : "(none)"
          }
        />
        <div className="mt-2">
          <p className="font-medium text-neutral-600">
            sources ({answer.sources.length})
          </p>
          {answer.sources.length === 0 ? (
            <p className="mt-1">(none)</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {answer.sources.map((s) => (
                <li key={s.srcId} className="break-words">
                  <span className="text-neutral-500">
                    [{s.srcId} / score {s.score.toFixed(3)}]
                  </span>{" "}
                  {s.excerpt}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="mt-2 text-neutral-400">
          {new Date(item.createdAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div data-testid={`row-${label}`} className="flex gap-2">
      <span className="w-44 shrink-0 text-neutral-500">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  );
}
