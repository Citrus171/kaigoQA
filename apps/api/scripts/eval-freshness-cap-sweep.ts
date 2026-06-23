// freshness cap 校正スクリプト（一回性・手動実行）。
//
// cap 値を [0.1, 0.2, 0.3, 0.4, 0.5] でスイープし、
// routing-gold-a approved 77件の top-1 変化率を変化原因別に計測する。
//
// 出力:
//   cap | total_changed | superseded | freshness_penalty | yearDeltaAvg（penalty変化時の新旧年差）
//
// 用途: cap=0.3（現在値）の「正答率低下 vs freshness変動」較正曲線を得る。
//   - superseded: isSuperseded フィルタによる変化（cap に依存しない）
//   - freshness_penalty: cap 値によって変わる鮮度ペナルティ起因の変化
//   - yearDeltaAvg: penalty 変化時に新 top-1 が何年新しいか（+ = 新しい方へ動いた = 意図通り）
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/eval-freshness-cap-sweep.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK, type RetrievedChunk } from "@/lib/rag";
import { extractYear, isSuperseded, FRESHNESS_PENALTY_FULL_YEARS } from "@/lib/freshness";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "eval", "data", "routing-gold-a.jsonl");
const OUT = join(HERE, "..", "eval", "results");

const SWEEP_CAPS = [0.1, 0.2, 0.3, 0.4, 0.5];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

interface GoldItem {
  id: string;
  query: string;
  reviewStatus: string;
}

interface CapResult {
  cap: number;
  totalChanged: number;
  supersededCount: number;
  freshnessPenaltyCount: number;
  yearDeltaAvg: number | null;
  changedIds: string[];
}

interface SweepSummary {
  timestamp: string;
  fullYears: number;
  total: number;
  results: CapResult[];
}

function applyFreshnessWithCap(hits: RetrievedChunk[], cap: number, now: Date = new Date()): RetrievedChunk[] {
  const nowYear = now.getFullYear();
  const kept = hits.filter((h) => !isSuperseded(h.heading, h.date));
  return kept
    .map((h) => {
      const year = extractYear(h.date) ?? undefined;
      const yearsOld = year ? Math.max(nowYear - year, 0) : 0;
      const penalty = year ? Math.min(yearsOld / FRESHNESS_PENALTY_FULL_YEARS, 1.0) * cap : 0;
      const finalScore = h.score * (1 - penalty);
      return { ...h, year, finalScore };
    })
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}

async function measureCap(approved: GoldItem[], cap: number): Promise<CapResult> {
  let supersededCount = 0;
  let freshnessPenaltyCount = 0;
  const yearDeltas: number[] = [];
  const changedIds: string[] = [];

  for (const g of approved) {
    const hits = await retrieveTopK(db, g.query, 5);
    const withFreshness = applyFreshnessWithCap(hits, cap);

    const cosineTop = hits[0];
    const freshnessTop = withFreshness[0];
    if (cosineTop?.srcId === freshnessTop?.srcId) continue;

    changedIds.push(g.id);
    const wasSuperseded = isSuperseded(cosineTop?.heading, cosineTop?.date);
    if (wasSuperseded) {
      supersededCount++;
    } else {
      freshnessPenaltyCount++;
      const cosineYear = extractYear(cosineTop?.date ?? null);
      const freshnessYear = extractYear(freshnessTop?.date ?? null);
      if (cosineYear != null && freshnessYear != null) {
        yearDeltas.push(freshnessYear - cosineYear);
      }
    }
  }

  const totalChanged = supersededCount + freshnessPenaltyCount;
  const yearDeltaAvg = yearDeltas.length > 0
    ? yearDeltas.reduce((a, b) => a + b, 0) / yearDeltas.length
    : null;

  return { cap, totalChanged, supersededCount, freshnessPenaltyCount, yearDeltaAvg, changedIds };
}

async function main() {
  const lines = (await readFile(GOLD, "utf8")).trim().split("\n");
  const allGold = lines.map((l) => JSON.parse(l) as GoldItem);
  const approved = allGold.filter((g) => g.reviewStatus === "approved");
  console.log(`routing-gold-a: approved ${approved.length}件 / fullYears=${FRESHNESS_PENALTY_FULL_YEARS}`);
  console.log(`cap sweep: ${SWEEP_CAPS.join(" / ")}\n`);

  const results: CapResult[] = [];

  for (const cap of SWEEP_CAPS) {
    const r = await measureCap(approved, cap);
    results.push(r);
  }

  console.log(`\n=== cap 校正曲線 ===`);
  console.log(`cap  | 変化計 | superseded | freshness_penalty | yearDeltaAvg（penalty変化時）`);
  console.log(`-----|--------|------------|-------------------|------------------------------`);
  for (const r of results) {
    const marker = r.cap === 0.3 ? " ← 現在値" : "";
    const delta = r.yearDeltaAvg != null ? `+${r.yearDeltaAvg.toFixed(1)}年` : "N/A";
    console.log(
      `${r.cap.toFixed(1)}  | ${String(r.totalChanged).padEnd(6)} | ${String(r.supersededCount).padEnd(10)} | ${String(r.freshnessPenaltyCount).padEnd(17)} | ${delta}${marker}`
    );
  }

  console.log(`\n解釈メモ:`);
  console.log(`  superseded はすべてのcap値で同一（cap非依存・廃止マーカーフィルタの純粋効果）`);
  console.log(`  freshness_penalty の増加分 = cap 上昇で追加でtop-1が変わったクエリ`);
  console.log(`  yearDeltaAvg > 0 = 新しいチャンクへ動いた（鮮度rerank意図通り）`);
  console.log(`  yearDeltaAvg = N/A = year抽出不能チャンク同士の変化`);

  const summary: SweepSummary = {
    timestamp: new Date().toISOString(),
    fullYears: FRESHNESS_PENALTY_FULL_YEARS,
    total: approved.length,
    results,
  };

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, "eval-freshness-cap-sweep.json");
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n結果 → ${outPath}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
