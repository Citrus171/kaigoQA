import { loadEnv } from "@/lib/load-env";
loadEnv();

import { nodeDb, endDb } from "@/db/node";
import { ragChunks } from "@/db/schema";
import { l2normalize } from "@/lib/embed";
import { sql } from "drizzle-orm";
import corpusArtifact from "../models/rag/corpus.json";

type RawChunk = { srcId: string; text: string; vector: number[] };
type Corpus = {
  embedModel: string;
  dim: number;
  count: number;
  chunks: RawChunk[];
};

const corpus = corpusArtifact as Corpus;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");

const db = nodeDb(url);

async function main() {
  console.log(
    `corpus: ${corpus.count} chunks / dim=${corpus.dim} / model=${corpus.embedModel}`,
  );

  if (corpus.dim !== 1024) {
    throw new Error(`次元が不一致: corpus=${corpus.dim} vs schema=1024`);
  }

  // 既存データをクリアしてから投入（冪等にするため）。
  await db.execute(sql`DELETE FROM rag_chunks`);

  // 成果物のベクトルは生値（未正規化）なので L2 正規化してから格納する。
  // pgvector の cosine distance(<=>) は正規化済みベクトルで精度保証される。
  const rows = corpus.chunks.map((c) => ({
    srcId: c.srcId,
    text: c.text,
    vector: l2normalize(c.vector),
  }));

  // 135件程度なら一括 INSERT で十分。
  await db.insert(ragChunks).values(rows);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ragChunks);

  console.log(`inserted: ${row?.count ?? 0} rows into rag_chunks`);

  // サンプル検索で cosine distance が動くか確認。
  const sampleVec = rows[0]!.vector;
  const sampleLiteral = `[${sampleVec.join(",")}]`;
  const sample = await db.execute(sql`
    SELECT src_id AS "srcId",
           1 - (vector <=> ${sampleLiteral}::vector) AS score
    FROM rag_chunks
    ORDER BY vector <=> ${sampleLiteral}::vector
    LIMIT 3
  `);
  console.log("sample retrieval (top-3 by cosine):");
  for (const row of sample.rows as { srcId: string; score: number }[]) {
    console.log(`  ${row.srcId}: score=${row.score.toFixed(4)}`);
  }

  await endDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
