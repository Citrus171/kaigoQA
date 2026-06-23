// rag_chunks の citation メタデータ（heading/date/source/year）の構造的正確性を測定する。
// ③eval CIゲートの citation 精度計測。backfill（①）後の品質保持を確認する。
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/eval-citation.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { sql } from "drizzle-orm";
import { extractYear } from "@/lib/freshness";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "eval", "results");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

interface ChunkRow {
  srcId: string;
  heading: string | null;
  date: string | null;
  source: string | null;
}

interface CitationSummary {
  timestamp: string;
  total: number;
  withHeading: number;
  withDate: number;
  withSource: number;
  withYear: number;
  headingPct: number;
  datePct: number;
  sourcePct: number;
  yearPct: number;
  missingCount: number;
  missingExamples: string[];
}

async function main() {
  const result = await db.execute(sql`
    SELECT src_id AS "srcId", heading, date, source
    FROM rag_chunks
    ORDER BY src_id
  `);
  const allChunks = result.rows as unknown as ChunkRow[];
  // mhlw-qa-* のみを対象（gold-A-* は合成テストデータで citation メタなし・期待動作）
  const chunks = allChunks.filter((c) => c.srcId.startsWith("mhlw-qa-"));
  const total = chunks.length;
  const skipped = allChunks.length - total;
  console.log(`rag_chunks: 全${allChunks.length}件中 mhlw-qa-* ${total}件を検査（gold-A等 ${skipped}件は除外）\n`);

  let withHeading = 0;
  let withDate = 0;
  let withSource = 0;
  let withYear = 0;
  const missing: string[] = [];

  for (const c of chunks) {
    if (c.heading) withHeading++;
    if (c.date) withDate++;
    if (c.source) withSource++;
    if (extractYear(c.date) !== null) withYear++;
    if (!c.heading || !c.date || !c.source) {
      missing.push(
        `${c.srcId}: heading=${c.heading ? "ok" : "NULL"} date=${c.date ? "ok" : "NULL"} source=${c.source ? "ok" : "NULL"}`,
      );
    }
  }

  const headingPct = (withHeading / total) * 100;
  const datePct = (withDate / total) * 100;
  const sourcePct = (withSource / total) * 100;
  const yearPct = (withYear / total) * 100;

  console.log(`=== citation メタデータ品質（mhlw-qa-* チャンク）===`);
  console.log(`heading あり: ${withHeading}/${total} = ${headingPct.toFixed(1)}%`);
  console.log(`date あり:    ${withDate}/${total} = ${datePct.toFixed(1)}%`);
  console.log(`source あり:  ${withSource}/${total} = ${sourcePct.toFixed(1)}%`);
  console.log(`year 抽出可:  ${withYear}/${total} = ${yearPct.toFixed(1)}%`);

  if (missing.length > 0) {
    console.log(`\n欠損チャンク（${missing.length}件・先頭10件）:`);
    missing.slice(0, 10).forEach((m) => console.log(`  ${m}`));
  } else {
    console.log(`\n欠損なし ✓`);
  }

  const summary: CitationSummary = {
    timestamp: new Date().toISOString(),
    total,
    withHeading,
    withDate,
    withSource,
    withYear,
    headingPct,
    datePct,
    sourcePct,
    yearPct,
    missingCount: missing.length,
    missingExamples: missing.slice(0, 20),
  };

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, "eval-citation-latest.json");
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n結果 → ${outPath}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
