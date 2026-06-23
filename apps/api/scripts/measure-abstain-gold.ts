// abstain-gold.jsonl の各質問を retrieveTopK にかけ、top-1 score と abstain 帯への入り方を測る。
// ABSTAIN_THRESHOLD 校正の材料（recall 重視＝gold を abstain させる閾値を探す）。
//   abstain 帯 = RAG_DOMAIN_THRESHOLD(0.5) ≤ topScore < ABSTAIN_THRESHOLD
//   < 0.5 は general 経路（abstention 対象外）、≥ ABSTAIN_THRESHOLD は通常生成（abstention 発火せず）
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/measure-abstain-gold.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK } from "@/lib/rag";
import { ABSTAIN_THRESHOLD } from "@/routes/ai";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "eval", "data", "abstain-gold.jsonl");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

const DOMAIN = 0.5;

async function main() {
  const lines = (await readFile(GOLD, "utf8")).trim().split("\n");
  const gold = lines.map((l) => JSON.parse(l) as { id: string; question: string });
  console.log(`abstain gold: ${gold.length} 件 / ABSTAIN_THRESHOLD=${ABSTAIN_THRESHOLD}\n`);

  const scores: number[] = [];
  let inAbstainBand = 0;
  let inGeneral = 0;
  let inGenerate = 0;

  console.log("id\ttopScore\tband\thit0_heading");
  for (const g of gold) {
    const hits = await retrieveTopK(db, g.question, 3);
    const top = hits[0];
    const s = top?.score ?? 0;
    scores.push(s);
    const band = s < DOMAIN ? `general(<${DOMAIN})` : s < ABSTAIN_THRESHOLD ? "ABSTAIN帯" : `通常生成(≥${ABSTAIN_THRESHOLD})`;
    if (s < DOMAIN) inGeneral++;
    else if (s < ABSTAIN_THRESHOLD) inAbstainBand++;
    else inGenerate++;
    console.log(`${g.id}\t${s.toFixed(4)}\t${band}\t${top?.heading ?? "(null)"}`);
  }

  scores.sort((a, b) => a - b);
  console.log(`\n=== 分布 ===`);
  console.log(`general(<${DOMAIN}): ${inGeneral}`);
  console.log(`ABSTAIN帯(${DOMAIN}〜${ABSTAIN_THRESHOLD}): ${inAbstainBand}`);
  console.log(`通常生成(≥${ABSTAIN_THRESHOLD}): ${inGenerate}`);
  console.log(`score min: ${scores[0]!.toFixed(4)} / max: ${scores[scores.length - 1]!.toFixed(4)} / median: ${scores[Math.floor(scores.length / 2)]!.toFixed(4)}`);
  console.log(`\n=== 校正のヒント（recall重視＝gold全件abstainさせる閾値）===`);
  console.log(`gold max score = ${scores[scores.length - 1]!.toFixed(4)} → これを ABSTAIN_THRESHOLD にすれば gold 全件 abstain`);
  console.log(`ただし知識ある質問の topScore 分布（measure-domain-threshold: 0.65〜0.72）と重なる場合は過剰abstainリスク`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
