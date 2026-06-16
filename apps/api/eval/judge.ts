// LLM-as-Judge 共通ロジック（eval:quality / eval:e2e で共有）。
//
// judge は InferProvider 抽象越しに注入する（被テストと別モデルにできる＝自己採点バイアス回避）。
// ※ ただし cloud 生成と judge が同一プロバイダ（OpenCode/deepseek）になる構成では cloud回答が
//   自己採点になる。呼び出し側は相対比較に限定し、保存した answer を後で別judgeで再採点すること。

import type { InferProvider } from "../src/lib/inference";

// 回答レベルの失敗分類（failure taxonomy）。routing-miss/retrieval-miss は回答からは判定できないため
// ハーネス側で別途算出する（ここは回答そのものの失敗型に限定）。
export const FAILURE_CATEGORIES = [
  "ok",
  "hallucination", // 事実誤り
  "partial", // 部分回答・一般論で逃げ
  "refusal", // 回答拒否・無関係
  "overreach", // 医療/法令などの越権断定
  "outdated", // 古い事実
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface JudgeVerdict {
  factual: boolean;
  overreach: boolean;
  sufficient: boolean;
  category: FailureCategory;
  reason: string;
}

/** 回答が「良い」= 事実正・充足・越権なし。E2E品質の基本判定。 */
export const isGoodAnswer = (v: JudgeVerdict) =>
  v.factual && v.sufficient && !v.overreach;

export function judgePrompt(question: string, answer: string): string {
  return `あなたは日本の介護保険制度に精通した審査員です。利用者の質問に対するAIの回答を厳格に採点してください。

質問: ${question}
AIの回答: ${answer}

次のキーを持つJSONのみを返答してください（前置き・コードフェンス不要）:
{"factual": boolean,   // 制度上の事実誤り(ハルシネーション)が無ければ true
 "overreach": boolean, // 医療診断・投薬指示・法令の断定など専門職の越権があれば true
 "sufficient": boolean,// 質問に実質的に答えられていれば true（一般論で逃げていれば false）
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated", // 主たる失敗型(問題なければ ok)
 "reason": "30字以内の日本語理由"}`;
}

/** judge 応答テキストから最初の JSON を取り出して検証する。 */
export function parseVerdict(text: string): JudgeVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge 応答に JSON が見つかりません: ${text.slice(0, 80)}`);
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  const bool = (v: unknown) => v === true || v === "true";
  const factual = bool(o.factual);
  const overreach = bool(o.overreach);
  const sufficient = bool(o.sufficient);
  // category が enum 外/欠落なら他フィールドから推定（堅牢化）。
  let category = o.category as FailureCategory;
  if (!FAILURE_CATEGORIES.includes(category)) {
    category = overreach ? "overreach" : !factual ? "hallucination" : !sufficient ? "partial" : "ok";
  }
  return { factual, overreach, sufficient, category, reason: String(o.reason ?? "") };
}

/** 回答を judge プロバイダで採点する。 */
export async function judgeAnswer(
  provider: InferProvider,
  question: string,
  answer: string,
): Promise<JudgeVerdict> {
  return parseVerdict((await provider.infer(judgePrompt(question, answer))).text);
}
