// 段1: 事前複雑度フィルタ（安価・ルールベース）。
// SLM を呼ぶ前に「明らかに重い/専門的」なプロンプトを即 cloud へ振り分ける。
// PoC注記: ここは本番では複雑度分類器に差し替える前提の暫定ルール。

export type Complexity = "simple" | "complex";

// cloud 即送りにする閾値・キーワード。マジックナンバーを避け定数化。
export const COMPLEXITY_RULES = {
  // 長文は文脈処理が重く SLM では精度が落ちやすい。
  maxSimpleChars: 200,
  // 専門領域（法令・医療診断・厳密計算）は誤答リスクが高いので即エスカレーション。
  keywords: [
    "法",
    "条",
    "診断",
    "処方",
    "計算",
    "証明",
    "判例",
    "税",
    "契約",
  ] as const,
} as const;

/** プロンプトの事前複雑度を判定する（SLM呼び出し前）。 */
export function classifyComplexity(
  prompt: string,
  rules = COMPLEXITY_RULES,
): Complexity {
  if (prompt.length > rules.maxSimpleChars) return "complex";
  if (rules.keywords.some((kw) => prompt.includes(kw))) return "complex";
  return "simple";
}
