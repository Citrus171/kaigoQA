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

// reference 採点版プロンプト。実務者が作成した「正解要点(referencePoints)」を採点基準として渡す。
//   狙い: judge 自身の知識に依存した採点（=モデルの気分で揺れる）を、固定の要点リストとの
//   突き合わせに置き換える。実証結果(2026-06-17)では分散低減でなく「甘い採点の是正」に効いた。
//   要点ベースにする理由: 長文の模範回答を渡すと judge が「言い回しの類似度」を測りに行き（それは
//   embedding の仕事）。要点リストなら表現差に過敏反応せず、要点ごとに満たす/矛盾を判定できる。
//   ★充足閾値の明示(2026-06-17): 「何個満たせば十分か」が未定義だと弱judgeが境界で揺れる(flip増)。
//   そこで要点を「★=中心要点(全て満たせば sufficient)」「★なし=補足要点(欠落は sufficient に無関係)」
//   に分け、閾値を明示する。★が1つも無い場合は全要点を中心要点とみなす（後方互換）。
export function judgePromptWithReference(question: string, answer: string, points: string[]): string {
  const hasCore = points.some((p) => p.startsWith("★"));
  const list = points.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
  // 充足の判定ルール（★の有無で文面を切替）。
  const rule = hasCore
    ? "sufficient は「★が付いた中心要点をすべて実質的に満たしている」場合のみ true。★が付かない補足要点の欠落は sufficient に影響しない（あれば加点だが必須ではない）。"
    : "sufficient は「列挙した要点に実質的に答えられている」場合に true（一般論で逃げていれば false）。";
  return `あなたは日本の介護保険制度に精通した審査員です。実務者が作成した「採点の正解要点」を基準に、AIの回答を厳格に採点してください。
言い回しや詳しさの一致度（類似度）は問いません。各要点に照らして、AIの回答が要点と矛盾していないか・要点を満たしているかだけを判定します。

質問: ${question}
採点の正解要点（実務者作成・これを事実の根拠とする。★=中心要点 / ★なし=補足要点）:
${list}
AIの回答: ${answer}

採点ルール: ${rule}

次のキーを持つJSONのみを返答してください（前置き・コードフェンス不要）:
{"factual": boolean,   // どの要点とも矛盾する事実誤りが無ければ true（言い回しの違いは誤りとしない）
 "overreach": boolean, // 医療診断・投薬指示・法令の断定など専門職の越権があれば true
 "sufficient": boolean,// 上記の採点ルールに従って判定
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

/**
 * 回答を judge プロバイダで採点する。
 * referencePoints（実務者の正解要点）を渡すと参照採点プロンプトに切り替わる（ノイズ床↓）。
 * 空配列/undefined なら従来の reference なし採点＝既存呼び出しは無変更で後方互換。
 */
export async function judgeAnswer(
  provider: InferProvider,
  question: string,
  answer: string,
  referencePoints?: string[],
): Promise<JudgeVerdict> {
  const prompt = referencePoints?.length
    ? judgePromptWithReference(question, answer, referencePoints)
    : judgePrompt(question, answer);
  return parseVerdict((await provider.infer(prompt)).text);
}
