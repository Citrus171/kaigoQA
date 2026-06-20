// RAG retrieval（フェーズ2 Capability Router の検索段）。
//
// build:rag が出力した自己完結コーパス成果物（models/rag/corpus.json）をロードし、
// 受信クエリ1件を CF bge-m3 で埋め込んでコサイン類似の top-k チャンクを返す。
// 埋め込みは Provider 抽象（EmbedProvider）で注入でき、prod(Workers AI binding) へ差し替え可能。
//
// 採用パラメータの根拠（eval out/41）: chunk 粒度=1質問1chunk連結, top-3 で top-1 gid 95.1% / top-3 採用。

import { cosine, l2normalize, type EmbedProvider } from "@/lib/embed";
import { CfBgeM3EmbedProvider } from "@/lib/cf-embed";
import corpusArtifact from "../../models/rag/corpus.json";

type RawChunk = { srcId: string; text: string; vector: number[] };
type Corpus = {
  embedModel: string;
  dim: number;
  count: number;
  chunks: RawChunk[];
};

const corpus = corpusArtifact as Corpus;

// 成果物のベクトルは生値（未正規化）なので、起動時に1度だけ L2 正規化する
// （cosine() は正規化済み前提の内積。クエリ側も embed プロバイダで正規化される）。
const normalizedChunks = corpus.chunks.map((c) => ({
  srcId: c.srcId,
  text: c.text,
  vector: l2normalize(c.vector),
}));

export type RetrievedChunk = {
  srcId: string;
  text: string;
  score: number;
};

/** retrieval 既定 k（eval out/41 で確定）。 */
export const RETRIEVAL_K = 3;

/** コーパス成果物のメタ（observability / バージョン記録用）。 */
export const ragCorpusInfo = {
  embedModel: corpus.embedModel,
  count: corpus.count,
  dim: corpus.dim,
};

/**
 * クエリに最も近い top-k チャンクを返す（コサイン降順）。
 * embed 未指定時は成果物と同じ CF bge-m3 を使い、埋め込み空間を一致させる。
 */
export async function retrieveTopK(
  query: string,
  k: number = RETRIEVAL_K,
  embed: EmbedProvider = new CfBgeM3EmbedProvider(),
): Promise<RetrievedChunk[]> {
  const [qVec] = await embed.embed([query]);
  if (!qVec) throw new Error("クエリ埋め込みの取得に失敗しました");
  if (qVec.length !== corpus.dim) {
    throw new Error(`次元不一致: query ${qVec.length} vs corpus ${corpus.dim}`);
  }
  return normalizedChunks
    .map((c) => ({ srcId: c.srcId, text: c.text, score: cosine(qVec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
