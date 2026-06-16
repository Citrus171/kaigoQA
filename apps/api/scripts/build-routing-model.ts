// ルーティングモデルのビルドスクリプト（MLOps投資B = モデルレジストリ）。
//
// train（routing-prototypes）を埋め込み → クラスセントロイド + 非対称コスト最小の閾値を算出 →
// held-out gold で評価 → metrics・データハッシュ込みの成果物 JSON を出力する。
// 1コマンドで再現でき、prod 投入物が git で追える。
//
// 実行: npm run build:model -w @hybrid/api   （要 Ollama 起動）
//   埋め込みモデルは OLLAMA_EMBED_MODEL（既定 bge-m3）。
//
// 出力:
//   models/routing/v1-<model>.json  … バージョン付きアーカイブ
//   models/routing/current.json     … serving がロードする現行ポインタ（全文コピー）
//
// serving 側は src/lib/routing.ts が current.json をロードする（起動時再計算を廃止）。

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OllamaEmbedProvider, cosine, l2normalize } from "../src/lib/embed";
import { centroid, tuneThreshold, type Tier } from "../src/lib/classify-embed";
import { routingPrototypes as routingTrain } from "../src/lib/routing-prototypes";
import { routingGold } from "../eval/routing-gold";
import { routingModelSchema, type RoutingModel } from "../src/lib/routing-model";

const COST_FN = Number(process.env.AI_ROUTER_COST_FN ?? 10);
const COST_FP = Number(process.env.AI_ROUTER_COST_FP ?? 1);
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "bge-m3";

/** train/gold データの正準ハッシュ（取り違え・サイレント変更の検知用）。 */
function dataHash(items: { query: string; label: Tier }[]): string {
  const canonical = JSON.stringify(items.map((i) => [i.query, i.label]));
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/** positive=cloud の混同行列と指標。 */
function evaluate(scores: number[], labels: Tier[], threshold: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < scores.length; i++) {
    const pred: Tier = scores[i]! > threshold ? "cloud" : "edge";
    if (labels[i] === "cloud") pred === "cloud" ? tp++ : fn++;
    else pred === "cloud" ? fp++ : tn++;
  }
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f2 = precision + recall === 0 ? 0 : (5 * precision * recall) / (4 * precision + recall);
  const cost = fn * COST_FN + fp * COST_FP;
  return { tp, fp, fn, tn, recall, precision, f2, cost };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main() {
  const embed = new OllamaEmbedProvider(undefined, EMBED_MODEL);
  console.log(`=== build:model （埋め込み=${embed.name}）===`);
  console.log(`train=${routingTrain.length}件 / gold=${routingGold.length}件`);

  // 1) train を一括埋め込み → クラスセントロイド（index 保持でラベル別に分離）。
  const trainVecs = await embed.embed(routingTrain.map((p) => p.query));
  const dim = trainVecs[0]!.length;
  const cloudVecs: number[][] = [];
  const edgeVecs: number[][] = [];
  routingTrain.forEach((p, i) => {
    (p.label === "cloud" ? cloudVecs : edgeVecs).push(trainVecs[i]!);
  });
  const cloudC = centroid(cloudVecs);
  const edgeC = centroid(edgeVecs);

  // 2) train スコアから非対称コスト最小の閾値を選ぶ。
  //    score = sim(cloud) - sim(edge)。※ in-sample のため楽観的（1スカラー調整で過学習は限定的）。
  const score = (vecs: number[][]) =>
    vecs.map((v) => {
      const n = l2normalize(v);
      return cosine(n, cloudC) - cosine(n, edgeC);
    });
  const trainScores = score(trainVecs);
  const threshold = tuneThreshold(
    trainScores,
    routingTrain.map((p) => p.label),
    COST_FN,
    COST_FP,
  );

  // 3) held-out gold で評価。
  const goldVecs = await embed.embed(routingGold.map((g) => g.query));
  if (goldVecs[0]!.length !== dim) {
    throw new Error(`gold の埋め込み次元 ${goldVecs[0]!.length} が train ${dim} と不一致`);
  }
  const goldScores = score(goldVecs);
  const metrics = evaluate(goldScores, routingGold.map((g) => g.expected), threshold);

  // 4) 成果物の組み立て。
  const slug = EMBED_MODEL.replace(/[:/]/g, "-");
  const model: RoutingModel = {
    version: `v1-${slug}`,
    date: new Date().toISOString().slice(0, 10),
    embedModel: EMBED_MODEL,
    dim,
    centroids: { cloud: cloudC, edge: edgeC },
    threshold,
    costRatio: { fn: COST_FN, fp: COST_FP },
    metrics,
    trainSize: routingTrain.length,
    goldSize: routingGold.length,
    trainHash: dataHash(routingTrain.map((p) => ({ query: p.query, label: p.label }))),
    goldHash: dataHash(routingGold.map((g) => ({ query: g.query, label: g.expected }))),
  };
  // 自身のスキーマで往復検証（serving と同じ検証を通す）。
  routingModelSchema.parse(model);

  // 5) 出力（versioned + current ポインタ）。
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "models", "routing");
  mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(model, null, 2) + "\n";
  writeFileSync(join(outDir, `${model.version}.json`), json);
  writeFileSync(join(outDir, "current.json"), json);

  console.log(`閾値 t*=${threshold.toFixed(4)}（cost FN:${COST_FN}/FP:${COST_FP}）`);
  console.log(
    `gold: Recall=${pct(metrics.recall)} Precision=${pct(metrics.precision)} F2=${metrics.f2.toFixed(3)} ` +
    `(TP=${metrics.tp} FN=${metrics.fn} FP=${metrics.fp} TN=${metrics.tn}) 加重コスト=${metrics.cost}`,
  );
  console.log(`出力: models/routing/${model.version}.json + current.json`);
}

main().catch((e) => {
  console.error("build:model 失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});
