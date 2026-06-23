// abstain e2e 測定: フル pipeline（retrieval → applyFreshness → domainAnswer + ④grounding）で
// 実効 FN 率を計測する。
//
// 【FN_e2e の定義】
//   abstain-gold 全件中、フル pipeline を通しても「答えてしまった」割合。
//   FN_mechanical（機械閾値のみ）と比べて ④grounding による削減効果を数値で示す。
//
// 内訳:
//   - mechanical_abstain : topScore 0.5〜0.58 帯 → 機械的に abstain。grounding 未実施。
//   - grounding_abstain  : 生成帯(≥0.58)に入ったが grounding で abstain。FN 削減分。
//   - answered           : フル pipeline を通してもなお答えてしまった（残存 FN）。
//   - general            : topScore < 0.5。RAG 外として generalAnswer が回答（稀）。
//
// 実行条件:
//   - kubectl port-forward -n kaigo postgres-0 5436:5432
//   - OPENCODE_API_KEY（cloud grounding に必須）
//   - AI_EDGE_PROVIDER=ollama の場合は Ollama 起動（既定=WorkersAiProvider）
//
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/eval-abstain-e2e.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK, applyFreshness, RETRIEVAL_K } from "@/lib/rag";
import { domainAnswer, generalAnswer, ABSTAIN_THRESHOLD } from "@/routes/ai";
import { OllamaProvider, OpenCodeProvider, WorkersAiProvider, type InferProvider } from "@/lib/inference";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "eval", "data", "abstain-gold.jsonl");
const OUT = join(HERE, "..", "eval", "results");

const RAG_DOMAIN_THRESHOLD = 0.5;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

function pickEdge(): InferProvider {
  return process.env.AI_EDGE_PROVIDER === "ollama"
    ? new OllamaProvider()
    : new WorkersAiProvider();
}

type MechanicalBand = "general" | "abstain" | "generate";
type FinalOutcome = "mechanical_abstain" | "grounding_abstain" | "answered" | "general";

interface EvalItem {
  id: string;
  question: string;
  topScore: number;
  mechanicalBand: MechanicalBand;
  finalOutcome: FinalOutcome;
  // generate 帯に入った質問の詳細（それ以外は null）
  finalAbstained: boolean | null;
  groundingFired: boolean | null;
  grounded: boolean | null;
  model: string | null;
  answerExcerpt: string | null;
}

interface EvalSummary {
  timestamp: string;
  abstainThreshold: number;
  edgeProvider: string;
  cloudProvider: string;
  total: number;
  // 機械的 abstain（FN_mechanical の逆）
  mechanicalAbstainCount: number;
  // 生成帯に流れた件数（FN_mechanical の分子）
  generateBandCount: number;
  fnMechanicalPct: number;
  // grounding による追加捕捉
  groundingAbstainCount: number;
  // フル pipeline 後も答えてしまった件数（残存 FN）
  answeredCount: number;
  fnE2ePct: number;
  // general 帯（参考）
  generalCount: number;
  items: EvalItem[];
}

async function main() {
  const lines = (await readFile(GOLD, "utf8")).trim().split("\n");
  const gold = lines.map((l) => JSON.parse(l) as { id: string; question: string });

  const edge = pickEdge();
  const cloud = new OpenCodeProvider();

  console.log(`abstain gold: ${gold.length} 件`);
  console.log(`ABSTAIN_THRESHOLD=${ABSTAIN_THRESHOLD} / edge=${edge.name} / cloud=${cloud.name}`);
  console.log(`\n${"id".padEnd(14)} ${"topScore".padEnd(10)} ${"band".padEnd(10)} outcome`);
  console.log("-".repeat(65));

  const items: EvalItem[] = [];
  let mechanicalAbstainCount = 0;
  let generateBandCount = 0;
  let groundingAbstainCount = 0;
  let answeredCount = 0;
  let generalCount = 0;

  for (const g of gold) {
    const rawHits = await retrieveTopK(db, g.question, RETRIEVAL_K);
    const topScore = rawHits[0]?.score ?? 0;
    const hits = applyFreshness(rawHits);

    let mechanicalBand: MechanicalBand;
    if (topScore < RAG_DOMAIN_THRESHOLD) mechanicalBand = "general";
    else if (topScore < ABSTAIN_THRESHOLD) mechanicalBand = "abstain";
    else mechanicalBand = "generate";

    let item: EvalItem;

    if (mechanicalBand === "abstain") {
      mechanicalAbstainCount++;
      item = {
        id: g.id,
        question: g.question,
        topScore,
        mechanicalBand,
        finalOutcome: "mechanical_abstain",
        finalAbstained: true,
        groundingFired: null,
        grounded: null,
        model: null,
        answerExcerpt: null,
      };
    } else if (mechanicalBand === "general") {
      // ドメイン外: generalAnswer を呼ぶが abstain-gold 的には「答えてしまった」に近い
      generalCount++;
      const result = await generalAnswer(g.question, edge, cloud);
      item = {
        id: g.id,
        question: g.question,
        topScore,
        mechanicalBand,
        finalOutcome: "general",
        finalAbstained: false,
        groundingFired: null,
        grounded: result.safety.grounded,
        model: result.model,
        answerExcerpt: result.answer.slice(0, 120),
      };
    } else {
      // generate 帯: フル pipeline（domainAnswer + grounding）
      generateBandCount++;
      let result: Awaited<ReturnType<typeof domainAnswer>>;
      try {
        result = await domainAnswer(g.question, hits, edge, cloud);
      } catch (e) {
        console.error(`  [ERROR] ${g.id}: ${e instanceof Error ? e.message : String(e)}`);
        // エラーは answered 扱いにしない。スキップして集計から除外。
        item = {
          id: g.id,
          question: g.question,
          topScore,
          mechanicalBand,
          finalOutcome: "answered",
          finalAbstained: null,
          groundingFired: null,
          grounded: null,
          model: null,
          answerExcerpt: `[ERROR] ${e instanceof Error ? e.message : String(e)}`,
        };
        items.push(item);
        continue;
      }

      const finalAbstained = result.safety.abstained;
      const grounded = result.safety.grounded;
      // grounding が abstain させた = abstained かつ grounding 不支持
      const groundingFired = finalAbstained && grounded === false;

      let finalOutcome: FinalOutcome;
      if (groundingFired) {
        groundingAbstainCount++;
        finalOutcome = "grounding_abstain";
      } else if (finalAbstained) {
        // safety.abstained だが grounded は null（機械的 abstain が再度発火する場合は理論上ない）
        groundingAbstainCount++;
        finalOutcome = "grounding_abstain";
      } else {
        answeredCount++;
        finalOutcome = "answered";
      }

      item = {
        id: g.id,
        question: g.question,
        topScore,
        mechanicalBand,
        finalOutcome,
        finalAbstained,
        groundingFired: groundingFired,
        grounded,
        model: result.model,
        answerExcerpt: result.answer.slice(0, 120),
      };
    }

    const bandLabel = item.mechanicalBand.padEnd(10);
    console.log(`${g.id.padEnd(14)} ${topScore.toFixed(4).padEnd(10)} ${bandLabel} ${item.finalOutcome}`);
    items.push(item);
  }

  const fnMechanicalPct = (generateBandCount / gold.length) * 100;
  const fnE2ePct = (answeredCount / gold.length) * 100;

  console.log(`\n${"=".repeat(65)}`);
  console.log(`=== abstain e2e 測定結果 ===`);
  console.log(`total: ${gold.length}`);
  console.log(`\n【機械的フィルタ（threshold=${ABSTAIN_THRESHOLD}）】`);
  console.log(`  abstain帯(${RAG_DOMAIN_THRESHOLD}〜${ABSTAIN_THRESHOLD}): ${mechanicalAbstainCount}件 → 機械的 abstain`);
  console.log(`  generate帯(≥${ABSTAIN_THRESHOLD}): ${generateBandCount}件 → LLMへ（FN_mechanical=${fnMechanicalPct.toFixed(1)}%）`);
  console.log(`  general帯(<${RAG_DOMAIN_THRESHOLD}): ${generalCount}件`);
  console.log(`\n【④grounding による追加捕捉（generate帯 ${generateBandCount}件中）】`);
  console.log(`  grounding_abstain: ${groundingAbstainCount}件 → grounding で abstain`);
  console.log(`  answered: ${answeredCount}件 → grounding を通過してなお回答`);
  console.log(`\n【フル pipeline 実効 FN 率】`);
  console.log(`  FN_mechanical: ${generateBandCount}/${gold.length} = ${fnMechanicalPct.toFixed(1)}%`);
  console.log(`  FN_e2e       : ${answeredCount}/${gold.length} = ${fnE2ePct.toFixed(1)}%`);
  console.log(`  grounding 削減: ${(fnMechanicalPct - fnE2ePct).toFixed(1)} pp（${groundingAbstainCount}件追加捕捉）`);

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    abstainThreshold: ABSTAIN_THRESHOLD,
    edgeProvider: edge.name,
    cloudProvider: cloud.name,
    total: gold.length,
    mechanicalAbstainCount,
    generateBandCount,
    fnMechanicalPct,
    groundingAbstainCount,
    answeredCount,
    fnE2ePct,
    generalCount,
    items,
  };

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, "eval-abstain-e2e-latest.json");
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n結果 → ${outPath}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
