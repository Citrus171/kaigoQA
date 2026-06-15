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
import { buildCentroidClassifier } from "../src/lib/classify-embed";
import { routingGold, type GoldCase, type Tier } from "./routing-gold";
import { routingTrain } from "./routing-train";

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
    const tStar = pickThreshold(
      trainScored.map((s) => s.score),
      routingTrain.map((t) => t.label),
    );
    tunedM = report(
      `(C) Step3: 閾値チューニング後 (t*=${tStar.toFixed(3)} on train)`,
      toResults(
        routingGold,
        goldScored.map((p) => (p.score > tStar ? "cloud" : "edge")),
      ),
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

// 加重コスト(FN×COST_FN + FP×COST_FP)を最小化する閾値を選ぶ。
// 同コストなら t を小さく（cloud寄り＝FN少）取り、安全側に倒す。
function pickThreshold(scores: number[], labels: Tier[]): number {
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
    const cost = fn * COST_FN + fp * COST_FP;
    if (cost < best.cost) best = { t: Number.isFinite(t) ? t : -1, cost };
  }
  return best.t;
}

main();
