// ルーティングモデルの「アーティファクト」定義 + serving 側ロード/分類（MLOps投資B）。
//
// 従来 routing.ts は起動時に Ollama でプロトタイプを毎回埋め込み、セントロイドと閾値を
// 再計算していた。これを build:model（scripts/build-routing-model.ts）が事前計算した
// 成果物 JSON に置き換える。効果:
//   - コールドスタート誤振り分け解消（起動直後でも確定済みの境界を使う）。
//   - dev/prod 決定性（起動時に prototypes を埋め込む外部依存が消え、実行時は受信クエリのみ埋め込む）。
//   - prod 投入物が git で追える（成果物＝メタ込み JSON）。
// MLflow/W&B は複数モデル比較や UI が要るまで不要。現規模は JSON+git が正解。

import { z } from "zod";
import { cosine, l2normalize, type EmbedProvider } from "@/lib/embed";
import type { Tier } from "@/lib/classify-embed";

/** build:model が出力し serving がロードする成果物のスキーマ。 */
export const routingModelSchema = z.object({
  version: z.string(),
  date: z.string(),
  embedModel: z.string(),
  dim: z.number().int().positive(),
  // セントロイドは L2 正規化済み（cosine = 内積）。
  centroids: z.object({
    cloud: z.array(z.number()),
    edge: z.array(z.number()),
  }),
  // score = sim(cloud) - sim(edge)。score > threshold で cloud。
  threshold: z.number(),
  costRatio: z.object({ fn: z.number(), fp: z.number() }),
  // gold（held-out）上の評価値。動作点の根拠として成果物に同梱。
  metrics: z.object({
    tp: z.number(),
    fp: z.number(),
    fn: z.number(),
    tn: z.number(),
    recall: z.number(),
    precision: z.number(),
    f2: z.number(),
    cost: z.number(),
  }),
  trainSize: z.number().int(),
  goldSize: z.number().int(),
  // 学習/評価データの同一性検証（取り違え・サイレント変更の検知）。
  trainHash: z.string(),
  goldHash: z.string(),
});

export type RoutingModel = z.infer<typeof routingModelSchema>;

export interface RoutingClassifier {
  classify(prompt: string): Promise<{
    tier: Tier;
    score: number;
    threshold: number; // 適用した閾値（観測用。score>threshold で cloud）
    simCloud: number; // cosine(v, cloudセントロイド)。"なぜ"の根拠
    simEdge: number; // cosine(v, edgeセントロイド)
  }>;
}

/**
 * 段1ルータの判定を「理由つき」で表す観測レコード（Router Observability MVP）。
 * 分岐ロジックは変えず、ai.ts のハンドラがこれを組んで RoutingLogger に流す。
 *   - 「なぜ」の本体は margin（=score-threshold）と simCloud/simEdge。
 *   - rule 経路（埋め込み不通フォールバック）では score 系は null。
 */
export interface RoutingDecision {
  tier: Tier;
  stage1: {
    method: "classifier" | "rule";
    score: number | null;
    threshold: number | null;
    margin: number | null;
    simCloud: number | null;
    simEdge: number | null;
  };
  stage2?: {
    edgeConfidence: number;
    escalated: boolean; // 自信不足で cloud へ巻き戻し
    guardrailEscalated: boolean; // ガードレール（危険断定）で cloud へ巻き戻し
  };
  served: Tier; // 実際に返した先（stage2 で反転しうる）
  versions: { embedModel: string; classifierVersion: string; genModel: string };
  latencyMs: { embed: number; gen: number; total: number };
}

/** 未知 JSON を検証して RoutingModel にする（ロード時の形・次元整合チェック）。 */
export function parseRoutingModel(raw: unknown): RoutingModel {
  const model = routingModelSchema.parse(raw);
  if (model.centroids.cloud.length !== model.dim ||
      model.centroids.edge.length !== model.dim) {
    throw new Error(
      `アーティファクト破損: dim=${model.dim} とセントロイド長が不一致`,
    );
  }
  return model;
}

/**
 * 成果物（事前計算済みセントロイド+閾値）と埋め込みプロバイダから分類器を作る。
 * 実行時は受信プロンプト1件のみ埋め込む（起動時の再計算なし）。
 * embed の埋め込み次元が成果物と異なる場合は throw（モデル取り違えの検知）。
 */
export function classifierFromModel(
  model: RoutingModel,
  embed: EmbedProvider,
): RoutingClassifier {
  const { cloud, edge } = model.centroids;
  return {
    async classify(prompt: string) {
      const [vec] = await embed.embed([prompt]);
      const v = l2normalize(vec!);
      if (v.length !== model.dim) {
        throw new Error(
          `埋め込み次元不一致: ${v.length} != ${model.dim}（成果物=${model.embedModel} / provider=${embed.name}）`,
        );
      }
      const simCloud = cosine(v, cloud);
      const simEdge = cosine(v, edge);
      const score = simCloud - simEdge;
      return {
        tier: score > model.threshold ? "cloud" : "edge",
        score,
        threshold: model.threshold,
        simCloud,
        simEdge,
      };
    },
  };
}
