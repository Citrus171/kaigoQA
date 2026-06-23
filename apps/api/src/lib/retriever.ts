// Retriever 抽象（ADR 0001 の Provider 注入パターンに準拠）。
//
// dense(embedding) / BM25(語彙) / hybrid(RRF) を同一インタフェースで差し替え可能にし、
// A1 hybrid の A/B 比較と Track B の FTS 差し替えに備える。
//
// 設計: 親計画書 §3 A1「interface で切り差し替え可能に」+ 実装方針「embed/inference と同パターン」。

import type { DB } from "@/db/schema";
import type { RetrievedChunk } from "@/lib/rag";
import { retrieveTopK } from "@/lib/rag";
import type { EmbedProvider } from "@/lib/embed";
import { CfBgeM3EmbedProvider } from "@/lib/cf-embed";
import { buildBm25Index, bm25Retrieve, type Bm25Index, type Bm25Doc } from "@/lib/bm25";

export type { RetrievedChunk } from "@/lib/rag";

export interface Retriever {
  readonly name: string;
  retrieve(query: string, k: number): Promise<RetrievedChunk[]>;
}

export interface RerankProvider {
  readonly name: string;
  rerank(query: string, chunks: RetrievedChunk[], topK: number): Promise<RetrievedChunk[]>;
}

export class DenseRetriever implements Retriever {
  readonly name = "dense(bge-m3+pgvector)";
  constructor(
    private readonly db: DB,
    private readonly embed: EmbedProvider = new CfBgeM3EmbedProvider(),
  ) {}
  async retrieve(query: string, k: number): Promise<RetrievedChunk[]> {
    return retrieveTopK(this.db, query, k, this.embed);
  }
}

export class Bm25Retriever implements Retriever {
  readonly name = "bm25(kuromoji)";
  private indexPromise: Promise<Bm25Index> | null = null;

  constructor(private readonly docs: Bm25Doc[]) {}

  private async getIndex(): Promise<Bm25Index> {
    if (!this.indexPromise) {
      this.indexPromise = buildBm25Index(this.docs);
    }
    return this.indexPromise;
  }

  async retrieve(query: string, k: number): Promise<RetrievedChunk[]> {
    const index = await this.getIndex();
    return bm25Retrieve(index, query, k);
  }
}

export function reciprocalRankFusion(
  resultsA: RetrievedChunk[],
  resultsB: RetrievedChunk[],
  k: number,
  c = 10,
  weightA = 5,
  weightB = 1,
): RetrievedChunk[] {
  const scoreMap = new Map<string, number>();
  const textMap = new Map<string, string>();
  // citation メタ（heading/date/source/page）は srcId 単位で引き継ぐ。
  // dense 結果にのみ付与される場合が多く、bm25 単独 srcId は undefined になる（optional で許容）。
  const metaMap = new Map<string, { heading?: string | null; date?: string | null; source?: string | null; page?: number | null }>();

  const merge = (r: RetrievedChunk) => {
    if (r.heading != null || r.date != null || r.source != null || r.page != null) {
      const prev = metaMap.get(r.srcId);
      metaMap.set(r.srcId, {
        heading: prev?.heading ?? r.heading,
        date: prev?.date ?? r.date,
        source: prev?.source ?? r.source,
        page: prev?.page ?? r.page,
      });
    }
  };

  for (let i = 0; i < resultsA.length; i++) {
    const r = resultsA[i]!;
    scoreMap.set(r.srcId, (scoreMap.get(r.srcId) ?? 0) + weightA / (c + i + 1));
    if (r.text) textMap.set(r.srcId, r.text);
    merge(r);
  }
  for (let i = 0; i < resultsB.length; i++) {
    const r = resultsB[i]!;
    scoreMap.set(r.srcId, (scoreMap.get(r.srcId) ?? 0) + weightB / (c + i + 1));
    if (r.text) textMap.set(r.srcId, r.text);
    merge(r);
  }

  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([srcId, score]) => ({ srcId, text: textMap.get(srcId) ?? "", score, ...metaMap.get(srcId) }));
}
