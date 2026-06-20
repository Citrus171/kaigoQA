// Capability Router（フェーズ2）。介護保険QA を意図で2分し、生成ポリシーを切り替える。
//
// 設計根拠（フェーズ1 out/34-41 の故障分離。詳細は eval/out42-router.py のドキュメント）:
// - 介護報酬の「計算系」質問は地域区分・事業所規模・時間区分・負担割合・本人所得など
//   質問文に与えられない変数に依存し、決定論的な単一解を持たない。
// - 本番 RAG 生成(V2)は「数値を省略するな」と指示するため、こうした underdetermined な質問では
//   数値の"捏造"を誘発する（factual 失敗）。
// - よって質問を knowledge_qa / escalate に振り分け、escalate には数値捏造を抑止する
//   guardrail 生成（手順＋確定制度定数＋ケアマネ誘導、断定禁止）を当てる。
//
// eval(out/42) 実測: 分類精度 98.5%（FP2/FN0）、KPI relaxed 92.6%→94.1%（回帰0）。

import { OpenCodeProvider, type InferProvider } from "@/lib/inference";
import type { AiRoute } from "@hybrid/shared";

// ── 分類器プロンプト（few-shot は test 135件と重複しない別例＝汚染回避。out42 と同一）──
const CLASSIFIER_PROMPT = `あなたは介護保険QAアシスタントのルーターです。利用者の質問を次の2つに分類してください。

- "escalate": 利用者**個人の具体的なケース**について、金額・自己負担額・利用回数・単位数などの**数値的な結果**を求めており、その答えが地域区分・事業所規模・サービス時間区分・負担割合・本人の所得など、質問文に与えられていない変数に依存して**一意に確定できない**もの。
- "knowledge_qa": 制度・要件・手続き・適格性の説明や、「どのように計算されるか（一般的な手順・仕組み）」の説明など、**参考知識で答えられる**もの。

例:
Q「母は要介護2です。デイサービスを週3回使うと毎月いくら払いますか」→ escalate
Q「限度額の範囲内で訪問看護は最大何回まで頼めますか」→ escalate
Q「介護保険の自己負担割合はどのように決まりますか」→ knowledge_qa
Q「福祉用具貸与を利用するにはどんな手続きが必要ですか」→ knowledge_qa
Q「看護小規模多機能型居宅介護とはどのようなサービスですか」→ knowledge_qa

質問: {query}

次のJSONのみを返答（前置き・コードフェンス不要）:
{"route": "escalate"|"knowledge_qa", "reason": "20字以内の判定理由"}`;

// ── knowledge_qa 生成: 本番 V2 EDGE_SYSTEM（rag-mvp.py と同一。数値を省略させない）──
export const KNOWLEDGE_QA_SYSTEM =
  "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。" +
  "回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・" +
  "加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。" +
  "利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。" +
  "核心情報は要約や一般論に置き換えず、具体的に記載してください。" +
  "「施設にご確認ください」「自治体にご確認ください」などの案内は、参考情報に回答が存在しない場合、" +
  "または施設・自治体ごとに運用が異なる事項に限って使用してください。" +
  "参考情報に記載されている事実や数値を、この案内によって省略してはいけません。" +
  "簡潔さは保ちつつ、利用者の判断に必要な数値・条件は漏れなく回答してください。目安は3〜5文です。" +
  "医療診断・投薬指示・法令の断定はしないこと。";

// ── escalate 生成: guardrail（V2 の「数値を省略するな」を route 適応で反転。out42 と同一）──
export const ESCALATE_SYSTEM =
  "あなたは介護施設の一次対応アシスタントです。この質問は利用者の具体的ケースの金額・回数・" +
  "単位数などの数値結果を尋ねていますが、これらは地域区分・事業所規模・サービス時間区分・" +
  "利用者負担割合・本人の所得・報酬改定などに依存し、一意に確定できません。次の方針で日本語で答えてください: " +
  "(1) 計算の手順・考え方（例: 単位数×利用回数×週数で月間総単位数を算出し限度額と比較）と、" +
  "判断に必要な前提条件（どの情報が分かれば算出できるか）を説明する。" +
  "(2) 区分支給限度基準額や各種上限額など、確定している制度の枠組み・数値があれば明示する。" +
  "(3) 個別の具体額・回数・単位数は断定せず、『正確な算定は担当ケアマネジャーに試算を依頼』" +
  "『単位数・基準額は最新の報酬改定で要確認』と明示的に案内する。" +
  "(4) 参考情報に金額・回数の目安（幅のある概算）が示されている場合は、その目安を幅と前提条件を" +
  "添えて必ず伝える（過度に省略しない）。一方、参考情報にない数値を推測で断定しない（捏造しない）。" +
  "3〜5文程度。医療診断・投薬指示・法令の断定はしないこと。";

// ── 確定制度定数（厚労省告示・公開値。gold 文字列の流用ではない知識 augmentation。out42 と同一）──
const SHIKYU_GENDO: Record<string, number> = {
  要支援1: 5032,
  要支援2: 10531,
  要介護1: 16765,
  要介護2: 19705,
  要介護3: 27048,
  要介護4: 30938,
  要介護5: 36217,
};
export const CONSTANTS_TEXT =
  "【確定制度定数（令和6年度）区分支給限度基準額（単位/月）】 " +
  Object.entries(SHIKYU_GENDO)
    .map(([k, v]) => `${k} ${v.toLocaleString()}単位`)
    .join(" / ") +
  "（1単位≈10円、地域区分で単価補正。福祉用具購入費の支給上限は年間10万円、" +
  "住宅改修費の支給上限は原則20万円）";

export type RouteDecision = { route: AiRoute; reason: string };

/**
 * 質問を knowledge_qa / escalate に分類する（cloud LLM・temperature 0）。
 * 解析失敗・未知ラベルは安全側の knowledge_qa にフォールバック（応答は止めない）。
 */
export async function classifyRoute(
  question: string,
  cloud: InferProvider = new OpenCodeProvider(),
): Promise<RouteDecision> {
  const { text } = await cloud.infer(
    CLASSIFIER_PROMPT.replace("{query}", question),
  );
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { route: "knowledge_qa", reason: "分類応答の解析失敗" };
  try {
    const o = JSON.parse(m[0]) as { route?: string; reason?: string };
    const route: AiRoute =
      o.route === "escalate" ? "escalate" : "knowledge_qa";
    return { route, reason: String(o.reason ?? "").slice(0, 30) };
  } catch {
    return { route: "knowledge_qa", reason: "分類JSONの解析失敗" };
  }
}

/** route に応じた system prompt を参考情報込みで組み立てる。 */
export function buildSystemPrompt(route: AiRoute, refTexts: string[]): string {
  const refBlock = refTexts.join("\n\n");
  if (route === "escalate") {
    return (
      ESCALATE_SYSTEM +
      `\n\n${CONSTANTS_TEXT}\n\n参考情報（介護保険の事実）:\n${refBlock}`
    );
  }
  return KNOWLEDGE_QA_SYSTEM + `\n\n回答の参考情報（介護保険の事実）:\n${refBlock}`;
}
