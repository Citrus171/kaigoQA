// RAG retrieval（フェーズ2 Capability Router の検索段／pgvector 版）。
//
// 受信クエリ1件を CF bge-m3 で埋め込み、pgvector(rag_chunks)の cosine distance(<=>)で
// top-k チャンクを取得する。コーパス本体は scripts/seed-rag.ts が DB に投入済み。
// JS の全件 cosine から「cosine の managed 実装(pgvector)」へ移行した（Phase 1 完了条件）。
// 埋め込みは Provider 抽象（EmbedProvider）で注入でき、prod(Workers AI binding) へ差し替え可能。
//
// 採用パラメータの根拠（eval out/41）: chunk 粒度=1質問1chunk連結, top-3 で top-1 gid 95.1% / top-3 採用。
//
// A1 hybrid: retrieveHybrid() で dense + BM25 を RRF 融合。

import { sql } from "drizzle-orm";
import type { DB } from "@/db/schema";
import type { EmbedProvider } from "@/lib/embed";
import { CfBgeM3EmbedProvider } from "@/lib/cf-embed";
import {
  DenseRetriever,
  Bm25Retriever,
  reciprocalRankFusion,
  type Retriever,
  type RerankProvider,
} from "@/lib/retriever";
import { loadBm25Docs } from "@/db/rag-chunks-loader";

export type RetrievedChunk = {
  srcId: string;
  text: string;
  score: number;
};

/** retrieval 既定 k（real-query eval で @5=96.2% / @3=80.8% から 5 に変更）。 */
export const RETRIEVAL_K = 5;

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

// ---- A1 hybrid: dense + BM25 → RRF 融合 ----

const hybridRetrieversCache = new WeakMap<DB, { dense: DenseRetriever; bm25: Bm25Retriever }>();

async function getHybridRetrievers(db: DB) {
  let cached = hybridRetrieversCache.get(db);
  if (!cached) {
    const docs = await loadBm25Docs(db);
    cached = {
      dense: new DenseRetriever(db),
      bm25: new Bm25Retriever(docs),
    };
    hybridRetrieversCache.set(db, cached);
  }
  return cached;
}

/**
 * dense(pgvector cosine) + BM25(kuromoji) の候補をそれぞれ top-N 件取得し、
 * Reciprocal Rank Fusion (RRF) で融合して top-k を返す。
 *
 * @param nCandidates 各 retriever から取得する候補数（既定 15）
 * @param rrfC RRF の c パラメータ（既定 10。135件小規模のため c=60 は rank 差を潰しすぎる）
 * @returns RRF 融合後の top-k チャンク
 */
export async function retrieveHybrid(
  db: DB,
  query: string,
  k: number = RETRIEVAL_K,
  nCandidates = 15,
  rrfC = 10,
  weightDense = 5,
  weightBm25 = 1,
): Promise<RetrievedChunk[]> {
  const { dense, bm25 } = await getHybridRetrievers(db);
  const [denseResults, bm25Results] = await Promise.all([
    dense.retrieve(query, nCandidates),
    bm25.retrieve(query, nCandidates),
  ]);
  return reciprocalRankFusion(denseResults, bm25Results, k, rrfC, weightDense, weightBm25);
}

/**
 * hybrid(RRF) で候補を拡張取得した後、cross-attention reranker で最終 top-k を返す。
 *
 * @param reranker RerankProvider 実装（CF bge-reranker-base 等）
 * @param nCandidates RRF に渡す拡張候補数（既定 20。reranker の入力プールを広げる）
 * @returns reranker スコア順の top-k チャンク
 */
export async function retrieveHybridWithRerank(
  db: DB,
  query: string,
  reranker: RerankProvider,
  k: number = RETRIEVAL_K,
  nCandidates = 20,
  rrfC = 10,
  weightDense = 5,
  weightBm25 = 1,
): Promise<RetrievedChunk[]> {
  const candidates = await retrieveHybrid(db, query, nCandidates, nCandidates, rrfC, weightDense, weightBm25);
  return reranker.rerank(query, candidates, k);
}
