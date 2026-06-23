// 既存 rag_chunks の mhlw 行に citation メタ（heading/date/source/page）を
// UPDATE で埋める。embedding は再計算しない（vector は既存のまま）。1回限りの backfill。
//
// 背景: embed-and-insert-pdf-chunks.ts は初回投入時に srcId/text/vector のみ格納し、
//   heading/date/source/page を捨てていた。schema に列を追加した後、このスクリプトで
//   mhlw-qa-chunks.jsonl のメタを既存行に UPDATE する（vector 再埋め込み不要）。
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: npx tsx scripts/backfill-rag-meta.ts

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNKS_PATH = join(HERE, "..", "eval", "data", "pdf", "mhlw-qa-chunks.jsonl");
const DB_URL = "postgresql://app:app@localhost:5436/functest_hono";

const BATCH_SIZE = 500;

async function main() {
  const txt = await readFile(CHUNKS_PATH, "utf8");
  const chunks = txt.trim().split("\n").map((l) => JSON.parse(l) as {
    srcId: string; heading?: string; date?: string; source?: string; page?: number;
  });
  console.log(`chunks to backfill: ${chunks.length}`);

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const { rows: before } = await client.query("SELECT count(*) FROM rag_chunks WHERE heading IS NOT NULL");
  console.log(`rows with heading before: ${before[0]!.count}`);

  let updated = 0;
  let notFound = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)!;
    const values = batch
      .map((_, j) => `($${j * 5 + 1}::text, $${j * 5 + 2}::text, $${j * 5 + 3}::text, $${j * 5 + 4}::text, $${j * 5 + 5}::integer)`)
      .join(", ");
    const params: (string | number | null)[] = [];
    for (const c of batch) {
      params.push(c.srcId, c.heading ?? null, c.date ?? null, c.source ?? null, c.page ?? null);
    }
    // VALUES + FROM で1バッチ1クエリ。srcId 一致行のみ UPDATE（vector は触らない）。
    const res = await client.query(
      `UPDATE rag_chunks r
         SET heading = v.heading, date = v.date, source = v.source, page = v.page
       FROM (VALUES ${values}) AS v(src_id, heading, date, source, page)
       WHERE r.src_id = v.src_id`,
      params,
    );
    updated += res.rowCount ?? 0;
    notFound += batch.length - (res.rowCount ?? 0);
    process.stdout.write(`\r  processed ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }
  console.log(`\nupdated: ${updated}, not found(srcId 不一致): ${notFound}`);

  const { rows: after } = await client.query("SELECT count(*) FROM rag_chunks WHERE heading IS NOT NULL");
  console.log(`rows with heading after: ${after[0]!.count} (期待: 1954)`);
  const { rows: total } = await client.query("SELECT count(*) FROM rag_chunks");
  console.log(`rag_chunks total: ${total[0]!.count} (期待: 2089)`);

  const { rows: sample } = await client.query(
    `SELECT src_id, heading, date, source, page FROM rag_chunks WHERE heading IS NOT NULL LIMIT 3`,
  );
  console.log("sample:", JSON.stringify(sample, null, 2));

  await client.end();
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
