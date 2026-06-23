// abstain-gold.jsonl の各質問を retrieveTopK にかけ、機械的FN率を測定する。
// FN（False Negative）= abstain すべき質問を通常生成させてしまった率（機械的閾値判定ベース）。
// ③eval CIゲートのベースライン。(b)方針: 現状値を下回らない回帰検知に使う。
//
// 注意: 機械的FN率はLLM grounding（参考情報にないと正直に答える）を含まない。
//   真のFN改善はgrounding実装（④）で担保。本スクリプトはscore帯の回帰検知のみ。
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/eval-abstain.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK } from "@/lib/rag";
import { ABSTAIN_THRESHOLD } from "@/routes/ai";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "eval", "data", "abstain-gold.jsonl");
const OUT = join(HERE, "..", "eval", "results");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

const DOMAIN_THRESHOLD = 0.5;

type Band = "general" | "abstain" | "generate";

interface EvalItem {
  id: string;
  topScore: number;
  band: Band;
  heading: string | null;
}

interface EvalSummary {
  timestamp: string;
  abstainThreshold: number;
  total: number;
  inGeneral: number;
  inAbstainBand: number;
  inGenerate: number;
  fnMechanicalCount: number;
  fnMechanicalPct: number;
  items: EvalItem[];
}

function classifyBand(score: number): Band {
  if (score < DOMAIN_THRESHOLD) return "general";
  if (score < ABSTAIN_THRESHOLD) return "abstain";
  return "generate";
}

async function main() {
  const lines = (await readFile(GOLD, "utf8")).trim().split("\n");
  const gold = lines.map((l) => JSON.parse(l) as { id: string; question: string });
  console.log(`abstain gold: ${gold.length} 件 / ABSTAIN_THRESHOLD=${ABSTAIN_THRESHOLD}\n`);

  const items: EvalItem[] = [];
  let inGeneral = 0;
  let inAbstainBand = 0;
  let inGenerate = 0;

  console.log("id\t\ttopScore\tband\t\theading");
  for (const g of gold) {
    const hits = await retrieveTopK(db, g.question, 3);
    const top = hits[0];
    const score = top?.score ?? 0;
    const band = classifyBand(score);

    if (band === "general") inGeneral++;
    else if (band === "abstain") inAbstainBand++;
    else inGenerate++;

    items.push({ id: g.id, topScore: score, band, heading: top?.heading ?? null });
    console.log(`${g.id}\t${score.toFixed(4)}\t\t${band}\t\t${top?.heading ?? "(null)"}`);
  }

  const fnMechanicalCount = inGenerate;
  const fnMechanicalPct = (fnMechanicalCount / gold.length) * 100;

  console.log(`\n=== FN 計測結果 ===`);
  console.log(`total: ${gold.length}`);
  console.log(`general(<${DOMAIN_THRESHOLD}): ${inGeneral}`);
  console.log(`ABSTAIN帯(${DOMAIN_THRESHOLD}〜${ABSTAIN_THRESHOLD}): ${inAbstainBand}`);
  console.log(`generate(≥${ABSTAIN_THRESHOLD}): ${inGenerate}`);
  console.log(`FN_mechanical: ${fnMechanicalCount}/${gold.length} = ${fnMechanicalPct.toFixed(1)}%`);
  console.log(`（${inAbstainBand}件のみ機械的abstain発火。残${inGenerate}件はLLM grounding依存）`);

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    abstainThreshold: ABSTAIN_THRESHOLD,
    total: gold.length,
    inGeneral,
    inAbstainBand,
    inGenerate,
    fnMechanicalCount,
    fnMechanicalPct,
    items,
  };

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, "eval-abstain-latest.json");
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n結果 → ${outPath}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
