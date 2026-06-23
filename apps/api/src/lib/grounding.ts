import type { InferProvider } from "@/lib/inference";

// RAG grounding チェック（④）。
// 生成済み回答が retrieved chunks に支持されているかを cloud LLM で判定する。
// 支持されていない場合は false を返し、呼び出し側が ABSTAIN_MESSAGE に差し替える。
//
// 失敗(LLMエラー等)は fail-open（true を返す）。
// grounding チェックで良質な回答をブロックするよりも、捏造を通す方が観測可能なため。
export async function checkGrounding(
  question: string,
  answer: string,
  chunks: string[],
  cloud: InferProvider,
): Promise<boolean> {
  const context = chunks.slice(0, 5).join("\n---\n");
  const prompt =
    `以下の参照文書のみに基づいて、質問への回答が支持されているか判定してください。\n\n` +
    `参照文書:\n${context}\n\n` +
    `質問: ${question}\n\n` +
    `回答: ${answer}\n\n` +
    `「GROUNDED」か「UNGROUNDED」のどちらか一語のみで答えてください。`;
  try {
    const { text } = await cloud.infer(prompt);
    return !text.toUpperCase().includes("UNGROUNDED");
  } catch {
    return true;
  }
}
