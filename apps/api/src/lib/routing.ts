// ライブの段1ルータ（ADR 0001 Step2b = ai.ts wiring）。
// セントロイド分類器をプロセス内で一度だけ構築（プロトタイプ埋め込みは起動時1回）し、
// 以降はリクエスト毎にプロンプト1件を埋め込んで edge/cloud を判定する。
//
// 閾値は起動時に非対称コストでチューニング（env で上書き可・ハードコード回避）。
// ※ dev=Ollama 埋め込み前提。prod は別の埋め込み空間のため再構築・再チューニングが必要。

import type { EmbedProvider } from "@/lib/embed";
import { buildCentroidClassifier, tuneThreshold } from "@/lib/classify-embed";
import type { Tier } from "@/lib/classify-embed";
import { routingPrototypes } from "@/lib/routing-prototypes";

const COST_FN = Number(process.env.AI_ROUTER_COST_FN ?? 10);
const COST_FP = Number(process.env.AI_ROUTER_COST_FP ?? 1);

export interface RoutingClassifier {
  classify(prompt: string): Promise<{ tier: Tier; score: number }>;
}

// 埋め込みプロバイダ単位でキャッシュ（dev では実質1インスタンス）。
const cache = new WeakMap<EmbedProvider, Promise<RoutingClassifier>>();

export function getRoutingClassifier(
  embed: EmbedProvider,
): Promise<RoutingClassifier> {
  let built = cache.get(embed);
  if (!built) {
    built = build(embed);
    cache.set(embed, built);
  }
  return built;
}

async function build(embed: EmbedProvider): Promise<RoutingClassifier> {
  // bias=0 で構築し、score = sim(cloud)-sim(edge)（生の margin）を得る。
  const base = await buildCentroidClassifier(routingPrototypes, embed, 0);

  let threshold: number;
  const override = process.env.AI_ROUTER_THRESHOLD;
  if (override !== undefined && override.trim() !== "") {
    threshold = Number(override);
  } else {
    const scored = await base.classifyBatch(routingPrototypes.map((p) => p.query));
    threshold = tuneThreshold(
      scored.map((s) => s.score),
      routingPrototypes.map((p) => p.label),
      COST_FN,
      COST_FP,
    );
  }

  return {
    async classify(prompt: string) {
      const [r] = await base.classifyBatch([prompt]);
      const score = r!.score;
      return { tier: score > threshold ? "cloud" : "edge", score };
    },
  };
}
