// Layer2 品質eval = LLM-as-Judge harness（MLOps投資C）。
//
// Layer1(振り分け)とは別問題=「振り分け先の回答が正しいか/安全か」を測る。
// ここでは reference 不要の採点（judge 自身の知識で判定）を回す。実務者作成のゴールド回答が
// 揃ったら factuality を reference 採点へ拡張する（GoldCase に answer を足す seam）。
//
// 被テスト: edge SLM（llama3.2:1b）。「edge質問に edge が実際に安全に答えられるか」を検証する
//   = Layer1↔Layer2 の接続（答えられない/越権する質問は cloud へ再ラベル候補）。
// judge: OpenCode Go（deepseek-v4-flash）。被テスト(llama3.2:1b)と別系統＝自己採点バイアスなし。
//   ※ cloud 回答を判定する用途に転用する場合は judge と同一モデルになりバイアスが出るので注意。
//
// 出力指標:
//   - ハルシネーション率   : 制度上の事実誤りと judge が判定した割合。
//   - 越権率             : 医療診断/法令断定など専門職越権と judge が判定した割合。
//   - 充足不足率          : 質問に実質回答できていない割合（= cloud 再ラベル候補）。
//   - ガードレール再現    : ルールベース detectRiskyAssertion が judge 越権をどれだけ捕捉できたか。
//
// 実行: npm run eval:quality -w @hybrid/api （要 Ollama 起動 + OPENCODE_API_KEY）

import { OllamaProvider, OpenCodeProvider } from "../src/lib/inference";
import { detectRiskyAssertion } from "../src/lib/guardrail";
import { loadGold, type GoldCase } from "./data/load";
import { judgeAnswer, type JudgeVerdict } from "./judge";

interface QualityRow extends GoldCase {
  answer: string;
  verdict: JudgeVerdict | null; // edge生成失敗時は null（judge にかけられない）。
  ruleRisky: boolean; // ルールベース ガードレールの判定。
  genFailed: boolean; // edge が parseable な回答を出せなかった（それ自体が品質失敗）。
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const edge = new OllamaProvider();
  const judge = new OpenCodeProvider();
  // edge質問（expected=edge）に絞る: 「edge が安全に答えられるべき」想定の妥当性検証。
  const cases = loadGold().filter((g) => g.expected === "edge");

  console.log("=== Layer2 品質eval（LLM-as-Judge）===");
  console.log(`被テスト=${edge.name} / judge=${judge.name}`);
  console.log(`対象=edge質問 ${cases.length}件。edge生成→judge採点を実行中…\n`);

  // 1件の生成/採点失敗で全体を止めない（edge SLM は非JSONを返しうる=既知のライブ課題）。
  const rows: QualityRow[] = [];
  for (let i = 0; i < cases.length; i++) {
    const g = cases[i]!;
    process.stdout.write(`\r  進捗 ${i + 1}/${cases.length}`);
    let answer: string;
    try {
      answer = (await edge.infer(g.query)).text;
    } catch {
      // edge が parseable な回答を出せない＝それ自体が品質失敗（cloud 再ラベル候補）。
      rows.push({ ...g, answer: "", verdict: null, ruleRisky: false, genFailed: true });
      continue;
    }
    let verdict: JudgeVerdict;
    try {
      verdict = await judgeAnswer(judge, g.query, answer);
    } catch {
      // judge 応答が不正＝採点不能。安全側に倒し factual/sufficient=false 扱いで記録。
      verdict = { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
    }
    rows.push({ ...g, answer, verdict, ruleRisky: detectRiskyAssertion(answer).risky, genFailed: false });
  }
  console.log("\n");

  const judged = rows.filter((r) => r.verdict !== null);
  const genFailed = rows.filter((r) => r.genFailed);
  const j = judged.length;
  const hallucination = judged.filter((r) => !r.verdict!.factual);
  const overreach = judged.filter((r) => r.verdict!.overreach);
  // 充足不足 = judge が不十分と判定 + edge生成失敗（どちらも「答えられていない」）。
  const insufficient = [...judged.filter((r) => !r.verdict!.sufficient), ...genFailed];

  // ルールベース ガードレールが judge 越権をどれだけ捕捉したか（Layer2 防衛線の再現率）。
  const ruleCaught = overreach.filter((r) => r.ruleRisky).length;
  const ruleFalsePos = judged.filter((r) => r.ruleRisky && !r.verdict!.overreach).length;

  console.log("=== サマリ ===");
  console.log(`  採点対象           : ${j}/${rows.length}件（edge生成失敗 ${genFailed.length}件は採点外）`);
  console.log(`  ハルシネーション率 : ${pct(hallucination.length, j)} (${hallucination.length}/${j})`);
  console.log(`  越権率(judge)      : ${pct(overreach.length, j)} (${overreach.length}/${j})`);
  console.log(`  充足不足率         : ${pct(insufficient.length, rows.length)} (${insufficient.length}/${rows.length}) ← cloud再ラベル候補`);
  console.log(
    `  ガードレール再現    : judge越権 ${overreach.length}件中 ルール捕捉 ${ruleCaught}件 (${pct(ruleCaught, overreach.length)}) / 誤検知 ${ruleFalsePos}件`,
  );

  const report = (title: string, list: QualityRow[]) => {
    if (!list.length) return;
    console.log(`\n  ${title}:`);
    for (const r of list) {
      console.log(`    [${r.category}] ${r.query}`);
      console.log(`      judge: ${r.verdict?.reason ?? "（edge生成失敗）"}`);
    }
  };
  report("ハルシネーション", hallucination);
  report("越権(医療/法令断定)", overreach);
  report("充足不足(edge質問にedgeが答えられない=cloud再ラベル候補)", insufficient);
}

main().catch((e) => {
  console.error("\neval:quality 失敗:", e instanceof Error ? e.message : e);
  console.error("（要 Ollama 起動 + OPENCODE_API_KEY。judge=OpenCode Go）");
  process.exit(1);
});
