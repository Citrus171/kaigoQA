// 段1の複雑度分類器（ADR 0001 Step2）: セントロイド・コサイン分類。
//
// 2048次元の埋め込み × 少数ラベルでは Logistic Regression は過学習する領域のため、
// プロトタイプ最近傍（クラス平均=セントロイドへのコサイン類似）を採用。
// 線形分類器の一種で、少データに堅牢。LR化はラベルが増えた段階(Step3以降)で再検討。
//
// 非対称コスト(ADR 0001 制約1): bias で「cloud に倒しやすく」できる。
// score = sim(cloud) - sim(edge) + bias。bias>0 で FN(取りこぼし) を減らし FP を増やす。
// 既定 bias=0（最近傍）。動作点の確定は Step3(検証split)で行う前提。

import type { EmbedProvider } from "@/lib/embed";
import { cosine, l2normalize } from "@/lib/embed";

export type Tier = "edge" | "cloud";

export interface LabeledExample {
  query: string;
  label: Tier;
}

export interface EmbedClassifier {
  classify(query: string): Promise<{ tier: Tier; score: number }>;
  classifyBatch(queries: string[]): Promise<{ tier: Tier; score: number }[]>;
}

/** 複数ベクトルの平均→L2正規化（セントロイド）。 */
function centroid(vectors: number[][]): number[] {
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  return l2normalize(sum.map((x) => x / vectors.length));
}

/**
 * 学習プロトタイプからセントロイドを構築して分類器を返す。
 * embedProvider は dev=Ollama / prod=Workers AI（ADR制約3の抽象）。
 */
export async function buildCentroidClassifier(
  examples: LabeledExample[],
  embedProvider: EmbedProvider,
  bias = 0,
): Promise<EmbedClassifier> {
  const cloud = examples.filter((e) => e.label === "cloud");
  const edge = examples.filter((e) => e.label === "edge");
  if (cloud.length === 0 || edge.length === 0) {
    throw new Error("各クラスに最低1件の学習例が必要です");
  }
  // 1リクエストで全プロトタイプを埋め込む。
  const all = await embedProvider.embed(examples.map((e) => e.query));
  const byQuery = new Map(examples.map((e, i) => [e.query, all[i]!]));
  const cloudCentroid = centroid(cloud.map((e) => byQuery.get(e.query)!));
  const edgeCentroid = centroid(edge.map((e) => byQuery.get(e.query)!));

  const decide = (vec: number[]): { tier: Tier; score: number } => {
    const v = l2normalize(vec);
    const score = cosine(v, cloudCentroid) - cosine(v, edgeCentroid) + bias;
    return { tier: score > 0 ? "cloud" : "edge", score };
  };

  return {
    async classify(query) {
      const [vec] = await embedProvider.embed([query]);
      return decide(vec!);
    },
    async classifyBatch(queries) {
      const vecs = await embedProvider.embed(queries);
      return vecs.map(decide);
    },
  };
}

/**
 * score>t を cloud とする閾値 t を、加重コスト(FN×costFn + FP×costFp)最小で選ぶ。
 * 同コストなら t を小さく（cloud寄り＝FN少）取り安全側へ倒す。
 * ※ in-sample で選ぶと楽観的。本番は独立した検証split/ prod埋め込みで再選定すること。
 */
export function tuneThreshold(
  scores: number[],
  labels: Tier[],
  costFn = 10,
  costFp = 1,
): number {
  const candidates = [
    -Infinity,
    ...scores.map((s) => s - 1e-6),
    ...scores.map((s) => s + 1e-6),
  ].sort((a, b) => a - b);
  let best = { t: 0, cost: Infinity };
  for (const t of candidates) {
    let fn = 0;
    let fp = 0;
    for (let i = 0; i < scores.length; i++) {
      const pred: Tier = scores[i]! > t ? "cloud" : "edge";
      if (labels[i] === "cloud" && pred === "edge") fn++;
      if (labels[i] === "edge" && pred === "cloud") fp++;
    }
    const cost = fn * costFn + fp * costFp;
    if (cost < best.cost) best = { t: Number.isFinite(t) ? t : -1, cost };
  }
  return best.t;
}
