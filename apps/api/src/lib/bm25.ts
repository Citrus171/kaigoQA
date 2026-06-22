// BM25 語彙検索（アプリ層・throwaway・135件前提）。
//
// A1 hybrid の BM25 成分。rag_chunks 全件を起動時ロードし、
// kuromojin で形態素解析→転置インデックス + IDF をメモリ構築。
// 標準 BM25(k1=1.5, b=0.75) で query×全 doc をスコアリング。
//
// Track B で数千件化したら pg_bigm/pgroonga に移行（捨てる前提）。
// 過度な抽象化・永続化は回避。

import { tokenize } from "kuromojin";
import type { RetrievedChunk } from "@/lib/rag";

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface Bm25Doc {
  srcId: string;
  text: string;
}

interface IndexedDoc {
  srcId: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}

export interface Bm25Index {
  docs: IndexedDoc[];
  avgdl: number;
  idf: Map<string, number>;
}

function preprocess(text: string): string {
  return text.replace(/,/g, "").replace(/[★×〜「」（）]/g, " ");
}

async function tokenizeContent(text: string): Promise<string[]> {
  const cleaned = preprocess(text);
  const tokens = await tokenize(cleaned);
  return tokens
    .filter((t) => {
      const surface = t.surface_form;
      const pos = t.pos ?? "";
      if (pos === "数") return true;
      if (surface.length <= 1) return false;
      if (/^[、。・？！ 　\s\n]$/.test(surface)) return false;
      if (pos.startsWith("名詞") || pos.startsWith("動詞") || pos.startsWith("形容詞")) return true;
      return false;
    })
    .map((t) => t.surface_form);
}

export async function buildBm25Index(docs: Bm25Doc[]): Promise<Bm25Index> {
  const indexed: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const terms = await tokenizeContent(doc.text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    indexed.push({ srcId: doc.srcId, text: doc.text, terms: tf, length: terms.length });
    totalLength += terms.length;
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const n = docs.length;
  const avgdl = totalLength / n;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((n - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { docs: indexed, avgdl, idf };
}

export async function bm25Search(
  index: Bm25Index,
  query: string,
  k1 = BM25_K1,
  b = BM25_B,
): Promise<{ srcId: string; score: number }[]> {
  const qTerms = await tokenizeContent(query);
  const scores = index.docs
    .map((doc) => {
      let score = 0;
      for (const qt of qTerms) {
        const idf = index.idf.get(qt);
        if (!idf || idf === 0) continue;
        const tf = doc.terms.get(qt) ?? 0;
        if (tf === 0) continue;
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / index.avgdl)));
      }
      return { srcId: doc.srcId, score };
    })
    .filter((s) => s.score > 0);
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

export async function bm25Retrieve(
  index: Bm25Index,
  query: string,
  k: number,
): Promise<RetrievedChunk[]> {
  const results = await bm25Search(index, query);
  return results.slice(0, k).map((r) => {
    const doc = index.docs.find((d) => d.srcId === r.srcId);
    return { srcId: r.srcId, text: doc?.text ?? "", score: r.score };
  });
}
