// E2E評価（Phase 2・最大の意思決定指標）。質問→振り分け→実生成→judge を一気通貫で測り、
// 3ポリシー（always-edge / always-cloud / routed）を品質×レイテンシ×コストで三角測量する。
//
// 主指標: Quality loss = AlwaysCloud − Routed。
//   小さい(例 95→93) → routerは低コスト/低遅延で cloud並み品質 ＝ 採用価値あり。
//   大きい(例 95→85) → router改善が先 or cloud直送。
//
// ★測定上の交絡（必読）: cloud生成と judge が同一 OpenCode(deepseek)＝cloud回答は自己採点で
//   楽観に膨らむ。したがって測定上の Quality loss は実際より大きく出る（cloud過大評価）。
//   「lossが小さければ router は確実に良い（保守的に安全）」と解釈する。絶対品質は信用しない。
//   → 後で別judge/reference採点できるよう、回答本文・latency・judge結果を JSONL に永続化する。
//
// 計算節約: 各goldで edge/cloud を1回ずつ生成し、always-edge/always-cloud は各々を、
//   routed は分類器が選んだ側の結果を再利用する（2生成+2採点/件）。
//
// 実行: npm run eval:e2e -w @hybrid/api （要 Ollama[gen+bge-m3] 起動 + OPENCODE_API_KEY）
//   edge生成モデルは OLLAMA_GEN_MODEL（既定 gemma3:4b 推奨）。

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OllamaProvider, OpenCodeProvider } from "../src/lib/inference";
import { getRoutingClassifier } from "../src/lib/routing";
import { loadGold, type Tier } from "./data/load";
import { judgeAnswer, isGoodAnswer, type JudgeVerdict, type FailureCategory } from "./judge";
import currentArtifact from "../models/routing/current.json";

// 成果物の閾値（ログ用）。getRoutingClassifier 内部の model.threshold と同値。
const classifierThreshold = (currentArtifact as { threshold: number }).threshold;

type Policy = "always-edge" | "always-cloud" | "routed";

interface Gen {
  answer: string;
  latencyMs: number;
  genFailed: boolean;
  verdict: JudgeVerdict | null;
  skipped?: boolean; // E2E_ONLY_CLOUD で edge 生成を省いた場合 true（失敗とは区別する）
}

interface CaseRecord {
  id: string;
  query: string;
  expected: Tier;
  category: string;
  answerSource: string;
  routing: { predictedTier: Tier; score: number; threshold: number; routerSource: "classifier" | "rule" };
  edge: Gen & { model: string };
  cloud: Gen & { model: string };
}

const judgeName = "opencode-go:deepseek-v4-flash"; // = cloud と同一（自己採点注意）。

async function timed(fn: () => Promise<string>): Promise<{ answer: string; latencyMs: number; genFailed: boolean }> {
  const t0 = performance.now();
  try {
    const answer = await fn();
    return { answer, latencyMs: Math.round(performance.now() - t0), genFailed: false };
  } catch {
    return { answer: "", latencyMs: Math.round(performance.now() - t0), genFailed: true };
  }
}

async function judgeOrNull(judge: OpenCodeProvider, q: string, a: string, failed: boolean): Promise<JudgeVerdict | null> {
  if (failed || a.trim() === "") return null;
  try {
    return await judgeAnswer(judge, q, a);
  } catch {
    return { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
  }
}

const genOf = (rec: CaseRecord, policy: Policy): Gen =>
  policy === "always-edge"
    ? rec.edge
    : policy === "always-cloud"
      ? rec.cloud
      : rec.routing.predictedTier === "edge"
        ? rec.edge
        : rec.cloud;

const pctl = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const edge = new OllamaProvider();
  const cloud = new OpenCodeProvider();
  const classifier = await getRoutingClassifier();
  // E2E_LIMIT で件数を絞れる（疎通確認用）。未指定なら全件。
  const limit = Number(process.env.E2E_LIMIT ?? 0);
  const gold = limit > 0 ? loadGold().slice(0, limit) : loadGold();
  // E2E_ONLY_CLOUD=1: edge生成(gemma3:4b)を省き、振り分け(bge-m3)+cloud生成+judgeのみ実行。
  //   GPU不在のCPU環境で always-cloud の絶対品質/latency を先取り確定するための代理モード。
  //   always-edge と routed(edge側) の品質は測れない＝GPUセッションで取得する。
  const onlyCloud = process.env.E2E_ONLY_CLOUD === "1";

  console.log("=== E2E評価（3ポリシー比較）===");
  console.log(`edge=${edge.name} / cloud=${cloud.name} / judge=${judgeName}（cloudと同一＝自己採点注意）`);
  console.log(`gold=${gold.length}件${limit > 0 ? `（E2E_LIMIT=${limit}）` : ""}。`);
  if (onlyCloud) console.log("⚠ E2E_ONLY_CLOUD=1: edge生成をスキップ（always-cloud品質/latencyのみ確定。edge側はGPU測定待ち）。");

  // フェーズ1: 全件の振り分けを先に確定（bge-m3 を連続使用＝gemma3:4b との交互ロード回避）。
  process.stdout.write("  [1/2] 振り分け(bge-m3)…");
  const routings = [];
  for (const g of gold) routings.push(await classifier.classify(g.query));
  console.log(" 完了");

  // フェーズ2: edge/cloud 生成 + judge 採点（bge-m3 はもう触らない）。
  console.log("  [2/2] 生成+採点:");
  const records: CaseRecord[] = [];
  for (let i = 0; i < gold.length; i++) {
    const g = gold[i]!;
    const { tier, score } = routings[i]!;
    const e = onlyCloud
      ? { answer: "", latencyMs: 0, genFailed: false, skipped: true }
      : await timed(async () => (await edge.infer(g.query)).text);
    const c = await timed(async () => (await cloud.infer(g.query)).text);
    const [ev, cv] = await Promise.all([
      e.skipped ? Promise.resolve(null) : judgeOrNull(cloud, g.query, e.answer, e.genFailed),
      judgeOrNull(cloud, g.query, c.answer, c.genFailed),
    ]);
    records.push({
      id: g.id,
      query: g.query,
      expected: g.expected,
      category: g.category,
      answerSource: g.answerSource,
      // preRoute は分類器失敗時に rule-base へ退避するが、ここでは成果物分類器を直接使う。
      routing: { predictedTier: tier, score, threshold: classifierThreshold, routerSource: "classifier" },
      edge: { ...e, verdict: ev, model: edge.name },
      cloud: { ...c, verdict: cv, model: cloud.name },
    });
    console.log(`    ${i + 1}/${gold.length} [${g.expected}→${tier}] edge:${e.latencyMs}ms cloud:${c.latencyMs}ms`);
  }

  // --- ポリシー別の集計 ---
  type Agg = { good: number; n: number; lat: number[]; cloudCalls: number; routingMiss: number };
  const policies: Policy[] = ["always-edge", "always-cloud", "routed"];
  const aggs = new Map<Policy, Agg>();
  for (const p of policies) {
    const a: Agg = { good: 0, n: 0, lat: [], cloudCalls: 0, routingMiss: 0 };
    for (const rec of records) {
      const gen = genOf(rec, p);
      if (gen.skipped) continue; // edge未測定の件は当該ポリシーの母数から除外（onlyCloud時）
      const usedCloud =
        p === "always-cloud" || (p === "routed" && rec.routing.predictedTier === "cloud");
      a.n++;
      if (usedCloud) a.cloudCalls++;
      a.lat.push(gen.latencyMs);
      if (gen.verdict && isGoodAnswer(gen.verdict)) a.good++;
      // routing-miss は routed のみ意味を持つ（予測tier != expected）。
      if (p === "routed" && rec.routing.predictedTier !== rec.expected) a.routingMiss++;
    }
    aggs.set(p, a);
  }

  // 振り分け分布（コスト/latencyの素地。onlyCloud でも常に正確に出る）。
  const routedEdge = records.filter((r) => r.routing.predictedTier === "edge").length;
  const routedCloud = records.length - routedEdge;
  console.log(`\n  振り分け分布: edge=${routedEdge}件 / cloud=${routedCloud}件（routedのcloud呼数=${routedCloud}/${records.length}）`);

  console.log("=== ポリシー比較（gold全件・品質は他者採点でないcloud側が楽観）===");
  console.log("  policy        | Quality(good率) | p50 lat | p95 lat | cloud呼数 | routing-miss");
  for (const p of policies) {
    const a = aggs.get(p)!;
    if (a.n === 0) {
      console.log(`  ${p.padEnd(13)} | ${"（GPU測定待ち）".padStart(11)} | edge生成スキップ中`);
      continue;
    }
    const miss = p === "routed" ? String(a.routingMiss) : "—";
    console.log(
      `  ${p.padEnd(13)} | ${pct(a.good, a.n).padStart(13)} | ${String(pctl(a.lat, 50)).padStart(5)}ms | ${String(pctl(a.lat, 95)).padStart(5)}ms | ${String(a.cloudCalls).padStart(7)}/${a.n} | ${miss}`,
    );
  }

  if (onlyCloud) {
    console.log(
      `\n  ★Quality loss は edge未測定のため算出不可（routedはcloud側${routedCloud}件のみ採点）。` +
        `\n   → always-cloud の絶対品質/latencyを確定。edge側はGPUセッションで取得し本指標を完成させる。`,
    );
  } else {
    const q = (p: Policy) => aggs.get(p)!.good / aggs.get(p)!.n;
    const loss = q("always-cloud") - q("routed");
    console.log(`\n  ★Quality loss (AlwaysCloud − Routed) = ${(loss * 100).toFixed(1)}pt`);
    console.log(
      loss <= 0.05
        ? "   → 小（≤5pt）。routerは低コストでcloud並み品質＝採用価値あり（自己採点込みで保守的）。"
        : "   → 大（>5pt）。ただしcloud側自己採点インフレ分を含む。router改善 or cloud直送を要検討。",
    );
  }

  // --- failure taxonomy（routed の失敗内訳）---
  const routedCats = new Map<FailureCategory | "routing-miss", number>();
  for (const rec of records) {
    if (rec.routing.predictedTier !== rec.expected) {
      routedCats.set("routing-miss", (routedCats.get("routing-miss") ?? 0) + 1);
    }
    const gen = genOf(rec, "routed");
    if (gen.skipped) continue; // edge未測定（onlyCloud）の件は failure として数えない
    const cat = gen.verdict?.category ?? "refusal";
    if (cat !== "ok") routedCats.set(cat, (routedCats.get(cat) ?? 0) + 1);
  }
  console.log("\n  routed failure taxonomy:");
  for (const [cat, n] of [...routedCats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(cat).padEnd(13)} ${n}`);
  }

  // --- 永続化（後日 別judge/reference で再採点できるよう全記録を保存）---
  const slug = (onlyCloud ? `${cloud.name}-cloudonly` : edge.name).replace(/[^a-z0-9]+/gi, "-");
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "data", `e2e-${slug}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true }); // data/ 不在でも全計算後の保存を失わない
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n保存: ${outPath}（${records.length}件・回答本文/latency/judge結果を含む）`);
}

main().catch((e) => {
  console.error("\neval:e2e 失敗:", e instanceof Error ? e.message : e);
  console.error("（要 Ollama[gen+bge-m3] + OPENCODE_API_KEY）");
  process.exit(1);
});
