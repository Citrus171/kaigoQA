// RAG retrieval（フェーズ2 Capability Router の検索段／pgvector 版）。
//
// 受信クエリ1件を CF bge-m3 で埋め込み、pgvector(rag_chunks)の cosine distance(<=>)で
// top-k チャンクを取得する。コーパス本体は scripts/seed-rag.ts が DB に投入済み。
// JS の全件 cosine から「cosine の managed 実装(pgvector)」へ移行した（Phase 1 完了条件）。
// 埋め込みは Provider 抽象（EmbedProvider）で注入でき、prod(Workers AI binding) へ差し替え可能。
//
// 採用パラメータの根拠（eval out/41）: chunk 粒度=1質問1chunk連結, top-3 で top-1 gid 95.1% / top-3 採用。

import { sql } from "drizzle-orm";
import type { DB } from "@/db/schema";
import type { EmbedProvider } from "@/lib/embed";
import { CfBgeM3EmbedProvider } from "@/lib/cf-embed";

export type RetrievedChunk = {
  srcId: string;
  text: string;
  score: number;
};

/** retrieval 既定 k（eval out/41 で確定）。 */
export const RETRIEVAL_K = 3;

/** コーパスの埋め込み次元（bge-m3）。クエリ次元の整合チェックに使う。 */
const EMBED_DIM = 1024;

/**
 * クエリに最も近い top-k チャンクを pgvector から取得する（cosine 類似降順）。
 * embed 未指定時は投入時と同じ CF bge-m3 を使い、埋め込み空間を一致させる。
 * 投入ベクトル・クエリベクトルとも L2 正規化済みのため score = 1 - cosine_distance。
 */
export async function retrieveTopK(
  db: DB,
  query: string,
  k: number = RETRIEVAL_K,
  embed: EmbedProvider = new CfBgeM3EmbedProvider(),
): Promise<RetrievedChunk[]> {
  const [qVec] = await embed.embed([query]);
  if (!qVec) throw new Error("クエリ埋め込みの取得に失敗しました");
  if (qVec.length !== EMBED_DIM) {
    throw new Error(`次元不一致: query ${qVec.length} vs corpus ${EMBED_DIM}`);
  }
  // クエリベクトルは pgvector のテキストリテラル '[v1,v2,...]' で渡す（${} はパラメータ化される）。
  const qLiteral = `[${qVec.join(",")}]`;
  const result = await db.execute(sql`
    SELECT src_id AS "srcId", text,
           1 - (vector <=> ${qLiteral}::vector) AS score
    FROM rag_chunks
    ORDER BY vector <=> ${qLiteral}::vector
    LIMIT ${k}
  `);
  return result.rows as RetrievedChunk[];
}
