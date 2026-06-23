// routing-gold-a.jsonl（approved）の各クエリを retrieveTopK にかけ、
// applyFreshness 適用前後の top-1 変化を測定する。
// ②date鮮度 cap=0.3 の影響測定。gold-A 正答率への悪影響がないかを確認する。
//
// 変化原因の区別:
//   "superseded"      : cosine top-1 が削除/廃止マーカーで除外された（isSuperseded=true）
//   "freshness_penalty": cosine top-1 は有効だが freshness penalty で順位が下がった
// cap=0.3 の効果を測定するには freshness_penalty のみを見る。
//
// 前提: kubectl port-forward -n kaigo postgres-0 5436:5432 が稼働中
// 実行: DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono npx tsx scripts/eval-freshness.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDb, endDb } from "@/db/node";
import { retrieveTopK, applyFreshness } from "@/lib/rag";
import { FRESHNESS_PENALTY_CAP, FRESHNESS_PENALTY_FULL_YEARS, isSuperseded } from "@/lib/freshness";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD = join(HERE, "..", "eval", "data", "routing-gold-a.jsonl");
const OUT = join(HERE, "..", "eval", "results");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

interface GoldItem {
  id: string;
  query: string;
  reviewStatus: string;
}

interface FreshnessItem {
  id: string;
  top1Changed: boolean;
  changeReason: "superseded" | "freshness_penalty" | null;
  cosineSrcId: string | null;
  freshnessSrcId: string | null;
  cosineScore: number;
  freshnessScore: number;
  cosineYear: number | null;
  freshnessYear: number | null;
}

interface FreshnessSummary {
  timestamp: string;
  cap: number;
  fullYears: number;
  total: number;
  top1ChangedCount: number;
  top1ChangedPct: number;
  supersededCount: number;
  freshnessPenaltyCount: number;
  items: FreshnessItem[];
}

async function main() {
  const lines = (await readFile(GOLD, "utf8")).trim().split("\n");
  const allGold = lines.map((l) => JSON.parse(l) as GoldItem);
  const approved = allGold.filter((g) => g.reviewStatus === "approved");
  console.log(`routing-gold-a: ${allGold.length}件中 approved ${approved.length}件を測定`);
  console.log(`freshness cap=${FRESHNESS_PENALTY_CAP} / fullYears=${FRESHNESS_PENALTY_FULL_YEARS}\n`);

  const items: FreshnessItem[] = [];
  let changedCount = 0;
  let supersededCount = 0;
  let freshnessPenaltyCount = 0;

  for (const g of approved) {
    const hits = await retrieveTopK(db, g.query, 5);
    const withFreshness = applyFreshness(hits);

    const cosineTop = hits[0];
    const freshnessTop = withFreshness[0];
    const top1Changed = cosineTop?.srcId !== freshnessTop?.srcId;

    let changeReason: "superseded" | "freshness_penalty" | null = null;
    if (top1Changed) {
      changedCount++;
      const wasSuperseded = isSuperseded(cosineTop?.heading ?? "", cosineTop?.date ?? null);
      changeReason = wasSuperseded ? "superseded" : "freshness_penalty";
      if (changeReason === "superseded") supersededCount++;
      else freshnessPenaltyCount++;

      const cy = (cosineTop as { year?: number } | undefined)?.year ?? null;
      const fy = (freshnessTop as { year?: number } | undefined)?.year ?? null;
      console.log(`[top1変化/${changeReason}] ${g.id}`);
      console.log(`  cosine:    srcId=${cosineTop?.srcId} score=${cosineTop?.score?.toFixed(4)} year=${cy ?? "?"}`);
      console.log(`  freshness: srcId=${freshnessTop?.srcId} finalScore=${(freshnessTop as { finalScore?: number } | undefined)?.finalScore?.toFixed(4)} year=${fy ?? "?"}`);
    }

    items.push({
      id: g.id,
      top1Changed,
      changeReason,
      cosineSrcId: cosineTop?.srcId ?? null,
      freshnessSrcId: freshnessTop?.srcId ?? null,
      cosineScore: cosineTop?.score ?? 0,
      freshnessScore: (freshnessTop as { finalScore?: number } | undefined)?.finalScore ?? 0,
      cosineYear: (cosineTop as { year?: number } | undefined)?.year ?? null,
      freshnessYear: (freshnessTop as { year?: number } | undefined)?.year ?? null,
    });
  }

  const top1ChangedPct = (changedCount / approved.length) * 100;

  console.log(`\n=== 鮮度 rerank 影響 ===`);
  console.log(`測定: approved ${approved.length}件`);
  console.log(`top-1変化: ${changedCount}/${approved.length} = ${top1ChangedPct.toFixed(1)}%`);
  console.log(`  うち superseded 除外: ${supersededCount}件`);
  console.log(`  うち freshness_penalty（cap=${FRESHNESS_PENALTY_CAP}効果）: ${freshnessPenaltyCount}件`);

  const summary: FreshnessSummary = {
    timestamp: new Date().toISOString(),
    cap: FRESHNESS_PENALTY_CAP,
    fullYears: FRESHNESS_PENALTY_FULL_YEARS,
    total: approved.length,
    top1ChangedCount: changedCount,
    top1ChangedPct,
    supersededCount,
    freshnessPenaltyCount,
    items,
  };

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, "eval-freshness-latest.json");
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n結果 → ${outPath}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
