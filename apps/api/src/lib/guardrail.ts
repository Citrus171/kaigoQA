// 出力ガードレール（MLOps投資C / 本番機能兼eval・reference不要）。
//
// 介護ドメインの安全網。2つの責務:
//   1. 免責文を常時付与（AI出力であることの明示）。
//   2. edge(SLM) 回答に医療アドバイス断定・法令断定が混じっていないか検知。
//      検知したら edge 回答を破棄し cloud へエスカレ（非対称コスト=安全側に倒す設計と整合）。
//
// 検知は保守的なルールベース。誤検知(FP)は cloud への過剰エスカレに留まり害が小さい一方、
// 見逃し(FN)は誤った医療/法令断定をユーザーに返す実害になるため、疑わしきはescalateする。
// ※ これは Layer1(振り分け) とは別の Layer2(出力品質) の防衛線。

export const AI_DISCLAIMER =
  "※AIによる参考情報です。最終的な判断は介護・医療・法務の専門職にご確認ください。";

export interface RiskRule {
  /** 検知理由（eval/ログ用の機械可読タグ）。 */
  reason: string;
  pattern: RegExp;
}

// 医療アドバイスの断定（診断・投薬・治癒の言い切り）。事実説明ではなく「指示・断定」を狙う。
const MEDICAL_RULES: RiskRule[] = [
  { reason: "medical:diagnosis", pattern: /(と|を)?診断(します|できます|されます|し(まし|)た)/ },
  { reason: "medical:medication", pattern: /(服用|服薬|投薬|処方)(して(ください|ね)?|します|が必要です|してよい)/ },
  { reason: "medical:cure", pattern: /(必ず|きっと)?(治ります|完治します|治療できます)/ },
  { reason: "medical:dismiss", pattern: /(受診|通院|医師(への|に)相談)は(不要|必要(ありません|ない))/ },
];

// 法令の断定（合法/違法・義務・罰則・権利の言い切り）。制度の事実説明と紛らわしいため、
// 「断定的な助言」に寄せた表現に限定する。
const LEGAL_RULES: RiskRule[] = [
  { reason: "legal:legality", pattern: /(違法|合法|適法|不法)(です|になります|と言えます)/ },
  { reason: "legal:penalty", pattern: /(罰則|処罰|起訴|逮捕)(が)?(あります|されます|の対象です)/ },
  { reason: "legal:obligation", pattern: /(法的に|法律上)(必ず|義務|認められ|禁止)/ },
  { reason: "legal:entitlement", pattern: /(受給|請求|還付)(でき(ます|る)|の権利があります)(と断言|と保証)/ },
];

const ALL_RULES: RiskRule[] = [...MEDICAL_RULES, ...LEGAL_RULES];

export interface GuardrailResult {
  risky: boolean;
  reasons: string[];
}

/**
 * テキストに医療/法令の断定が含まれるか検知する。
 * 一致した全ルールの reason を返す（重複は排除）。
 */
export function detectRiskyAssertion(text: string): GuardrailResult {
  const reasons = ALL_RULES.filter((r) => r.pattern.test(text)).map((r) => r.reason);
  return { risky: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** 免責文を1度だけ付与（既に含む場合は二重付与しない）。 */
export function withDisclaimer(text: string): string {
  const body = text.trimEnd();
  if (body.includes(AI_DISCLAIMER)) return body;
  return `${body}\n\n${AI_DISCLAIMER}`;
}
