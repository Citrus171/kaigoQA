// ルーティング判定の計測ハーネス（ADR 0001 Step1-2）。
//
// 注目(positive)クラス = "cloud"。本来Cloud→edge = False Negative が最も危険。
// 2つのルータを held-out gold で比較する:
//   (A) ベースライン: 段1 classifyComplexity（rule-base・決定的・無料）
//   (B) Step2: セントロイド分類器（routing-train を学習、埋め込みは dev=Ollama）
// 段2(出力confidence)は第2防衛線で本ハーネスの対象外。
//
// 実行: npm run eval:routing -w @hybrid/api  （要 Ollama 起動。未起動なら(A)のみ）
//
// 非対称コスト（ADR 0001 制約1）: FN を FP より重く置く。

import { classifyComplexity } from "../src/lib/classify";
import { OllamaEmbedProvider } from "../src/lib/embed";
import { buildCentroidClassifier, tuneThreshold } from "../src/lib/classify-embed";
import { routingPrototypes as routingTrain } from "../src/lib/routing-prototypes";
import { routingGold, type GoldCase, type Tier } from "./routing-gold";

const COST_FN = 10;
const COST_FP = 1;
const RECALL_TARGET = 0.9;

interface Result extends GoldCase {
  predicted: Tier;
  outcome: "TP" | "FP" | "FN" | "TN";
}

function outcomeOf(expected: Tier, predicted: Tier): Result["outcome"] {
  if (expected === "cloud") return predicted === "cloud" ? "TP" : "FN";
  return predicted === "cloud" ? "FP" : "TN";
}

function toResults(gold: GoldCase[], preds: Tier[]): Result[] {
  return gold.map((g, i) => ({
    ...g,
    predicted: preds[i]!,
    outcome: outcomeOf(g.expected, preds[i]!),
  }));
}

function metrics(results: Result[]) {
  const c = (o: Result["outcome"]) =>
    results.filter((r) => r.outcome === o).length;
  const [tp, fp, fn, tn] = [c("TP"), c("FP"), c("FN"), c("TN")];
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f2 =
    precision + recall === 0
      ? 0
      : (5 * precision * recall) / (4 * precision + recall);
  return { tp, fp, fn, tn, recall, precision, f2, cost: fn * COST_FN + fp * COST_FP };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface SweepPoint {
  t: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  recall: number;
  precision: number;
  f2: number;
  cost: number;
}

/**
 * gold 上で閾値 t を全域スイープし PR 曲線を返す（ADR0001 動作点再検討 Step1）。
 * score>t を cloud と判定。コスト比sweepは t* sweep と等価なのでこれ1回で十分。
 */
function sweepThresholds(gold: GoldCase[], scores: number[]): SweepPoint[] {
  const candidates = Array.from(
    new Set([
      -Infinity,
      ...scores.map((s) => s - 1e-6),
      ...scores.map((s) => s + 1e-6),
    ]),
  ).sort((a, b) => a - b);
  return candidates.map((t) => {
    const m = metrics(
      toResults(
        gold,
        scores.map((s) => (s > t ? "cloud" : "edge")),
      ),
    );
    return { t: Number.isFinite(t) ? t : -Infinity, ...m };
  });
}

/** Pareto frontier（recall/precision どちらも他点に劣らない点）を抽出。 */
function paretoFrontier(points: SweepPoint[]): SweepPoint[] {
  return points.filter(
    (p) =>
      !points.some(
        (q) =>
          q !== p &&
          q.recall >= p.recall &&
          q.precision >= p.precision &&
          (q.recall > p.recall || q.precision > p.precision),
      ),
  );
}

function reportSweep(name: string, gold: GoldCase[], scores: number[]) {
  const points = sweepThresholds(gold, scores);
  console.log(`### ${name}`);
  // Recall 目標を満たす中で最大 Precision の点（= 達成可能な最良動作点）。
  const feasible = points.filter((p) => p.recall >= RECALL_TARGET);
  const bestAtTarget = feasible.reduce<SweepPoint | null>(
    (best, p) => (best === null || p.precision > best.precision ? p : best),
    null,
  );
  // 全域での最小加重コスト点。
  const minCost = points.reduce((best, p) => (p.cost < best.cost ? p : best));
  // Pareto frontier を recall 昇順で表示（曲線の形＝診断材料）。
  const front = paretoFrontier(points).sort((a, b) => a.recall - b.recall);
  console.log("  Pareto frontier (t / Recall / Precision / F2 / 加重コスト):");
  for (const p of front) {
    const mark = p === bestAtTarget ? " ◀ Recall目標下の最良" : p === minCost ? " ◀ 最小コスト" : "";
    console.log(
      `    t=${p.t.toFixed(3).padStart(7)}  R=${pct(p.recall).padStart(6)}  P=${pct(p.precision).padStart(6)}  F2=${p.f2.toFixed(3)}  cost=${String(p.cost).padStart(3)}${mark}`,
    );
  }
  console.log("  --- 診断 ---");
  if (bestAtTarget) {
    console.log(
      `  Recall≥${pct(RECALL_TARGET)} で達成可能な最大Precision = ${pct(bestAtTarget.precision)} (t=${bestAtTarget.t.toFixed(3)}, FP=${bestAtTarget.fp})`,
    );
    console.log(
      bestAtTarget.precision < 0.7
        ? "  → frontier 全域でも高Precision化できない＝埋め込み(分離力)問題の可能性大。プロトタイプ増強/bge移行を検討。"
        : "  → 閾値選択で改善余地あり＝閾値問題。動作点をこの点へ寄せる。",
    );
  } else {
    console.log(
      `  Recall≥${pct(RECALL_TARGET)} を満たす閾値が存在しない＝埋め込み問題が濃厚。`,
    );
  }
  console.log("");
  return { bestAtTarget, minCost };
}

function report(name: string, results: Result[]) {
  const m = metrics(results);
  console.log(`### ${name}`);
  console.log(
    `  混同(positive=cloud): TP=${m.tp} FN=${m.fn}(危険) FP=${m.fp}(過剰) TN=${m.tn}`,
  );
  console.log(
    `  Recall=${pct(m.recall)}(目標${pct(RECALL_TARGET)}) Precision=${pct(m.precision)} F2=${m.f2.toFixed(3)} 加重コスト=${m.cost}`,
  );
  const fn = results.filter((r) => r.outcome === "FN");
  if (fn.length) {
    console.log(`  FN(取りこぼし) ${fn.length}件:`);
    for (const r of fn) console.log(`    [${r.category}] ${r.query}`);
  }
  const fp = results.filter((r) => r.outcome === "FP");
  if (fp.length) {
    console.log(`  FP(過剰エスカレ) ${fp.length}件:`);
    for (const r of fp) console.log(`    [${r.category}] ${r.query}`);
  }
  console.log("");
  return m;
}

async function main() {
  const total = routingGold.length;
  const cloudN = routingGold.filter((g) => g.expected === "cloud").length;
  console.log("=== ルーティング評価（held-out gold） ===");
  console.log(
    `gold: ${total}件 (cloud=${cloudN} / edge=${total - cloudN}) ※ラベル暫定・要実務者レビュー`,
  );
  console.log(`train(分類器学習): ${routingTrain.length}件（goldと別文言）`);
  console.log("");

  // (A) ベースライン
  const baseResults = toResults(
    routingGold,
    routingGold.map((g) =>
      classifyComplexity(g.query) === "complex" ? "cloud" : "edge",
    ),
  );
  const baseM = report("(A) ベースライン: 段1 rule-base", baseResults);

  // (B) セントロイド分類器（Ollama 未起動ならスキップ）
  let clsM: ReturnType<typeof metrics> | null = null;
  let tunedM: ReturnType<typeof metrics> | null = null;
  try {
    const embed = new OllamaEmbedProvider();
    const classifier = await buildCentroidClassifier(routingTrain, embed);
    // score = sim(cloud)-sim(edge)。cloud と判定する閾値 t: score>t → cloud。
    const goldScored = await classifier.classifyBatch(
      routingGold.map((g) => g.query),
    );
    clsM = report(
      `(B) Step2: セントロイド分類器 [${embed.name}] (bias=0 → 閾値t=0)`,
      toResults(
        routingGold,
        goldScored.map((p) => p.tier),
      ),
    );

    // (C) Step3: 非対称コスト最小の閾値を train 上で選び held-out に適用。
    // ※ train は in-sample（センチロイド構築に使用）のため閾値はやや楽観的。
    //   本番は独立した検証split推奨。1スカラー調整なので過学習は限定的。
    const trainScored = await classifier.classifyBatch(
      routingTrain.map((t) => t.query),
    );
    const tStar = tuneThreshold(
      trainScored.map((s) => s.score),
      routingTrain.map((t) => t.label),
      COST_FN,
      COST_FP,
    );
    tunedM = report(
      `(C) Step3: 閾値チューニング後 (t*=${tStar.toFixed(3)} on train)`,
      toResults(
        routingGold,
        goldScored.map((p) => (p.score > tStar ? "cloud" : "edge")),
      ),
    );

    // (D) 動作点再検討 Step1: gold 全域 PR sweep（閾値問題か埋め込み問題かを診断）。
    reportSweep(
      `(D) 閾値 全域sweep on gold [${embed.name}]`,
      routingGold,
      goldScored.map((p) => p.score),
    );
  } catch (e) {
    console.log("(B/C) スキップ: 埋め込み取得に失敗（Ollama起動を確認）");
    console.log(`    ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 比較サマリ
  if (clsM && tunedM) {
    console.log("=== 比較（held-out gold） ===");
    console.log(
      `  Recall : (A)${pct(baseM.recall)} → (B)${pct(clsM.recall)} → (C)${pct(tunedM.recall)}`,
    );
    console.log(
      `  FN     : (A)${baseM.fn} → (B)${clsM.fn} → (C)${tunedM.fn}（危険な取りこぼし）`,
    );
    console.log(
      `  加重コスト: (A)${baseM.cost} → (B)${clsM.cost} → (C)${tunedM.cost}`,
    );
    const pass = tunedM.recall >= RECALL_TARGET;
    console.log(
      pass
        ? `  ✅ Recall 目標達成 (${pct(tunedM.recall)} ≥ ${pct(RECALL_TARGET)})`
        : `  ⚠️ Recall 目標未達 (${pct(tunedM.recall)})。llama3.2:1b の埋め込み分離限界 → Step5(RAG)/モデル増強が必要`,
    );
    process.exit(pass ? 0 : 1);
  }
  process.exit(1);
}

main();
