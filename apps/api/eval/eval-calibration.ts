// 段2 confidence 較正チェック（ADR0001 動作点再検討 Step2）。
//
// 目的: 段2(edge SLM=llama3.2:1b)の自己申告 confidence が「正解tier」と相関するかを測る。
//   段2救済パス（段1=cloud判定を高confidenceでedgeへ戻す）が安全に機能するには、
//   「高confidence ⟺ 本当にedgeで十分」が成り立つ必要がある。
//   無相関なら救済は危険なFN（cloud漏れ）を再生産する → 救済路線は棄却 or logprobs化。
//
// 指標: AUC = P(ランダムなedge質問のconf > ランダムなcloud質問のconf)。
//   edge を「救済して良い側(positive)」とする。AUC=0.5→無相関、>0.7→使える信号。
//
// 実行: npm run eval:calibration -w @hybrid/api （要 Ollama 起動）
// ※ gold 全件に対し段2 SLM を実呼び出しするため数分かかる（実confidenceを測るため必須）。

import { OllamaProvider } from "../src/lib/inference";
import { OllamaEmbedProvider } from "../src/lib/embed";
import { buildCentroidClassifier, tuneThreshold } from "../src/lib/classify-embed";
import { routingPrototypes as routingTrain } from "../src/lib/routing-prototypes";
import { routingGold, type Tier } from "./routing-gold";

const COST_FN = 10;
const COST_FP = 1;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface Scored {
  query: string;
  expected: Tier;
  category: string;
  confidence: number;
  stage1: Tier; // 段1分類器の判定（救済対象の特定用）
}

/**
 * AUC（Mann-Whitney U）。pos群の値が neg群より大きい確率。
 * 同値は0.5として数える。pos/neg どちらか空なら NaN。
 */
function auc(posScores: number[], negScores: number[]): number {
  if (posScores.length === 0 || negScores.length === 0) return NaN;
  let wins = 0;
  for (const p of posScores) {
    for (const n of negScores) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (posScores.length * negScores.length);
}

function describe(label: string, xs: number[]) {
  if (xs.length === 0) {
    console.log(`  ${label}: (0件)`);
    return;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const uniq = new Set(xs.map((x) => x.toFixed(3))).size;
  console.log(
    `  ${label}: n=${xs.length} 平均=${mean.toFixed(3)} 中央=${median.toFixed(3)} 範囲=[${sorted[0]!.toFixed(3)}, ${sorted[sorted.length - 1]!.toFixed(3)}] 異なり値=${uniq}`,
  );
}

async function main() {
  console.log("=== 段2 confidence 較正チェック ===");
  console.log(`gold: ${routingGold.length}件。段2 SLM を実呼び出し中…（数分）\n`);

  // 段1分類器（救済対象＝段1cloud判定の特定に使用）。
  const embed = new OllamaEmbedProvider();
  const classifier = await buildCentroidClassifier(routingTrain, embed);
  const goldScores = await classifier.classifyBatch(routingGold.map((g) => g.query));
  const trainScores = await classifier.classifyBatch(routingTrain.map((t) => t.query));
  const tStar = tuneThreshold(
    trainScores.map((s) => s.score),
    routingTrain.map((t) => t.label),
    COST_FN,
    COST_FP,
  );

  // 段2 confidence を全件取得（実 inference）。
  const slm = new OllamaProvider();
  const scored: Scored[] = [];
  for (let i = 0; i < routingGold.length; i++) {
    const g = routingGold[i]!;
    let confidence = NaN;
    try {
      confidence = (await slm.infer(g.query)).confidence;
    } catch (e) {
      console.log(`  [warn] ${g.query.slice(0, 20)}… 段2失敗: ${e instanceof Error ? e.message : e}`);
    }
    scored.push({
      query: g.query,
      expected: g.expected,
      category: g.category,
      confidence,
      stage1: goldScores[i]!.score > tStar ? "cloud" : "edge",
    });
    process.stdout.write(`\r  進捗 ${i + 1}/${routingGold.length}`);
  }
  console.log("\n");

  const valid = scored.filter((s) => Number.isFinite(s.confidence));
  if (valid.length < scored.length) {
    console.log(`  ※ ${scored.length - valid.length}件は段2失敗のため除外\n`);
  }

  // --- 分析1: 全gold で edge vs cloud の confidence 分布と AUC ---
  console.log("### 分析1: 全gold（救済して良い側=edge を positive）");
  const edgeConf = valid.filter((s) => s.expected === "edge").map((s) => s.confidence);
  const cloudConf = valid.filter((s) => s.expected === "cloud").map((s) => s.confidence);
  describe("edge(本来) のconfidence", edgeConf);
  describe("cloud(本来) のconfidence", cloudConf);
  const aucAll = auc(edgeConf, cloudConf);
  console.log(`  AUC(edge>cloud) = ${aucAll.toFixed(3)}  ※0.5=無相関 / >0.7=使える\n`);

  // --- 分析2: 救済対象（段1=cloud判定）に絞った識別力 ---
  // この部分集合内で TP(本来cloud=救済禁止) と FP(本来edge=救済したい) を
  // confidence が分離できるか。救済は段1cloudにしか適用されない。
  console.log("### 分析2: 救済対象＝段1cloud判定の部分集合");
  const escalated = valid.filter((s) => s.stage1 === "cloud");
  const fp = escalated.filter((s) => s.expected === "edge"); // 救済したい
  const tp = escalated.filter((s) => s.expected === "cloud"); // 救済禁止(救済=FN化)
  console.log(`  段1cloud判定: ${escalated.length}件（うち FP=${fp.length} 救済したい / TP=${tp.length} 救済禁止）`);
  describe("FP(本来edge) のconfidence", fp.map((s) => s.confidence));
  describe("TP(本来cloud) のconfidence", tp.map((s) => s.confidence));
  const aucResc = auc(fp.map((s) => s.confidence), tp.map((s) => s.confidence));
  console.log(`  AUC(FP>TP) = ${Number.isNaN(aucResc) ? "N/A" : aucResc.toFixed(3)}`);

  // 安全な救済閾値の有無: TPを1件も救済せず(=新FN0)にFPを何件救済できるか。
  if (tp.length && fp.length) {
    const maxTpConf = Math.max(...tp.map((s) => s.confidence));
    const safelyRescued = fp.filter((s) => s.confidence > maxTpConf).length;
    console.log(
      `  新FNを出さず救済可能なFP = ${safelyRescued}/${fp.length}件（TP最大conf=${maxTpConf.toFixed(3)}超のFP数）`,
    );
  }
  console.log("");

  // --- 判定 ---
  console.log("### 判定");
  if (Number.isNaN(aucAll) || aucAll < 0.65) {
    console.log(
      `  ❌ 較正NG (AUC=${Number.isNaN(aucAll) ? "N/A" : aucAll.toFixed(3)} < 0.65)。自己申告confidenceは正解tierとほぼ無相関。`,
    );
    console.log("  → 段2救済(Step4)は棄却 or logprobs化前提で後回し。動作点改善は埋め込み側(選択肢C)へ。");
    process.exit(1);
  } else {
    console.log(`  ✅ 較正OK寄り (AUC=${aucAll.toFixed(3)} ≥ 0.65)。段2救済に一定の識別力あり。`);
    console.log("  → 救済閾値を設計し、FP削減 vs 新FN のトレードオフをeval-routingに組み込んで再評価。");
    process.exit(0);
  }
}

main();
