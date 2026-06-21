// Phase 1 完了条件の検証: メモリ全件 cosine と pgvector(<=>) の top-k が厳密一致するか。
//
// 「Vector DB は魔法でなく cosine の managed 実装」を体感するための回帰確認。
// 投入済みベクトルをそのままクエリに使うことで CF を叩かず決定論的に比較する
// （埋め込み API の揺れを排除し、retrieval ロジックの移行だけを検証する）。
// 実行: npm run verify:rag -w @hybrid/api（DB に rag_chunks が seed 済みであること）。

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK, RETRIEVAL_K } from "@/lib/rag";
import { cosine, l2normalize, type EmbedProvider } from "@/lib/embed";
import corpusArtifact from "../models/rag/corpus.json";

type RawChunk = { srcId: string; text: string; vector: number[] };
type Corpus = { embedModel: string; dim: number; count: number; chunks: RawChunk[] };
const corpus = corpusArtifact as Corpus;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

// 参照実装: 旧 retrieveTopK と同じ「全件 cosine → 降順 → top-k」を JS で再現する。
const normalized = corpus.chunks.map((c) => ({
  srcId: c.srcId,
  vector: l2normalize(c.vector),
}));
function jsTopK(qVec: number[], k: number) {
  return normalized
    .map((c) => ({ srcId: c.srcId, score: cosine(qVec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// 与えられたベクトルをそのまま返す埋め込みスタブ（CF を叩かない＝決定論）。
class FixedEmbed implements EmbedProvider {
  readonly name = "fixed-embed";
  constructor(private readonly v: number[]) {}
  async embed(_texts: string[]): Promise<number[][]> {
    return [this.v];
  }
}

const K = RETRIEVAL_K;
const SCORE_TOL = 1e-4; // float8(pg) と JS double の丸め差の許容。

async function main() {
  let mismatch = 0;
  for (const c of corpus.chunks) {
    const qVec = l2normalize(c.vector);
    const js = jsTopK(qVec, K);
    const pg = await retrieveTopK(db, "(stub)", K, new FixedEmbed(qVec));

    const jsIds = js.map((h) => h.srcId).join(",");
    const pgIds = pg.map((h) => h.srcId).join(",");
    const idsMatch = jsIds === pgIds;
    const scoreMatch = js.every(
      (h, i) => Math.abs(h.score - (pg[i]?.score ?? Number.NaN)) < SCORE_TOL,
    );

    if (!idsMatch || !scoreMatch) {
      mismatch++;
      console.log(`✗ query=${c.srcId}`);
      console.log(`   JS: ${jsIds}`);
      console.log(`   PG: ${pgIds}`);
    }
  }

  const total = corpus.chunks.length;
  console.log(`\n検証: ${total - mismatch}/${total} クエリで top-${K} が完全一致`);
  if (mismatch === 0) {
    console.log("✅ メモリ cosine と pgvector の top-k が厳密一致（cosine が DB に移っただけ）");
  } else {
    console.log(`❌ ${mismatch} 件で不一致`);
  }

  await endDb();
  process.exit(mismatch === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
