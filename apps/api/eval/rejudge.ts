// 独立 judge による再採点（Phase 3）。eval:e2e が保存した JSONL（回答本文入り）を読み、
// 生成系と別系統の judge（既定=OpenRouter経由 GPT-4o）で edge/cloud 回答を採点し直す。
//
// 目的: eval:e2e の cloud 採点は cloud と同一 deepseek＝自己採点でバイアスがある。生成を1回確定し
//   judge だけ差し替えて再採点することで「latency-55%を維持したまま品質維持できているか」を
//   自己採点バイアス無しで客観評価する（生成1回・judge何度でも＝研究資産）。
//
// 出力:
//   - ポリシー別 good率（独立judge採点ベース。eval:e2e の自己採点版と比較できる）
//   - 旧judge(deepseek)との一致度（= 自己採点が品質を過大評価していた度合いの定量化）
//   - 再採点 verdict を全件 JSONL に保存（多数決judge追加や再集計の素地）
//
// 実行: OPENROUTER_API_KEY=... npm run eval:rejudge -w @hybrid/api -- <input.jsonl>
//   入力省略時は eval/data/e2e-ollama-gemma3-4b.jsonl を採点。
//   judge切替: JUDGE_MODEL=anthropic/claude-opus-4 等（env、OpenAI直なら JUDGE_BASE_URL も）。

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenRouterProvider } from "../src/lib/inference";
import { judgeAnswer, isGoodAnswer, type JudgeVerdict } from "./judge";
import type { Tier } from "./data/load";

// eval:e2e が保存する 1 回答分のレコード（必要フィールドのみ。verdict は旧=deepseek採点）。
interface GenRec {
  answer: string;
  genFailed: boolean;
  skipped?: boolean;
  verdict: JudgeVerdict | null;
  model: string;
  rejudge?: JudgeVerdict | null; // 本スクリプトが付与する独立judge採点。
}
interface CaseRec {
  id: string;
  query: string;
  expected: Tier;
  routing: { predictedTier: Tier };
  edge: GenRec;
  cloud: GenRec;
}

type Policy = "always-edge" | "always-cloud" | "routed";

// eval:e2e と同一の選択ロジック（ポリシーが実際に使う側の回答を返す）。
const genOf = (rec: CaseRec, policy: Policy): GenRec =>
  policy === "always-edge"
    ? rec.edge
    : policy === "always-cloud"
      ? rec.cloud
      : rec.routing.predictedTier === "edge"
        ? rec.edge
        : rec.cloud;

// 採点可能 = スキップでも生成失敗でも空でもない（= 評価対象の本文がある）。
const judgeable = (g: GenRec) => !g.skipped && !g.genFailed && g.answer.trim() !== "";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const inPath = process.argv[2] ?? join(here, "data", "e2e-ollama-gemma3-4b.jsonl");
  const lines = readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const records = lines.map((l) => JSON.parse(l) as CaseRec);

  const judge = new OpenRouterProvider();
  console.log("=== 独立judge 再採点 ===");
  console.log(`入力: ${inPath}（${records.length}件）`);
  console.log(`judge: ${judge.name}（生成=deepseek系と別系統＝自己採点バイアス無し）\n`);

  // edge/cloud の採点対象を全件 judge にかける（sequential＝API負荷を抑制・進捗を可視化）。
  let done = 0;
  const total = records.reduce((n, r) => n + (judgeable(r.edge) ? 1 : 0) + (judgeable(r.cloud) ? 1 : 0), 0);
  for (const rec of records) {
    for (const side of ["edge", "cloud"] as const) {
      const g = rec[side];
      if (!judgeable(g)) {
        g.rejudge = null;
        continue;
      }
      try {
        g.rejudge = await judgeAnswer(judge, rec.query, g.answer);
      } catch (e) {
        // 採点不能は安全側（factual/sufficient=false）で記録し集計から欠落させない。
        g.rejudge = { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
        console.error(`\n  ⚠ ${rec.id}/${side} 採点失敗: ${e instanceof Error ? e.message : e}`);
      }
      process.stdout.write(`\r  採点 ${++done}/${total}`);
    }
  }
  console.log("\n");

  // --- ポリシー別 good率（独立judge / 旧deepseek自己採点 を並記）---
  const policies: Policy[] = ["always-edge", "always-cloud", "routed"];
  console.log("=== ポリシー別 good率（独立judge vs 旧deepseek自己採点）===");
  console.log("  policy        | 独立judge good率 | 旧deepseek good率 | n");
  const goodRate = (p: Policy, pick: (g: GenRec) => JudgeVerdict | null) => {
    let good = 0, n = 0;
    for (const rec of records) {
      const g = genOf(rec, p);
      if (!judgeable(g)) continue;
      const v = pick(g);
      if (!v) continue;
      n++;
      if (isGoodAnswer(v)) good++;
    }
    return { good, n };
  };
  for (const p of policies) {
    const ind = goodRate(p, (g) => g.rejudge ?? null);
    const old = goodRate(p, (g) => g.verdict);
    if (ind.n === 0) {
      console.log(`  ${p.padEnd(13)} | ${"（対象なし）".padStart(14)} | edge未測定`);
      continue;
    }
    console.log(
      `  ${p.padEnd(13)} | ${pct(ind.good, ind.n).padStart(14)} | ${pct(old.good, old.n).padStart(15)} | ${ind.n}`,
    );
  }

  // --- judge間 一致度（自己採点バイアスの定量化）---
  // 旧verdict と 新rejudge が両方ある回答について isGoodAnswer の一致を見る。
  let agree = 0, both = 0, oldGoodNewBad = 0, oldBadNewGood = 0;
  for (const rec of records) {
    for (const side of ["edge", "cloud"] as const) {
      const g = rec[side];
      if (!g.verdict || !g.rejudge) continue;
      both++;
      const o = isGoodAnswer(g.verdict), n = isGoodAnswer(g.rejudge);
      if (o === n) agree++;
      else if (o && !n) oldGoodNewBad++;
      else oldBadNewGood++;
    }
  }
  console.log("\n=== judge間 一致度（旧deepseek自己採点 ↔ 独立judge）===");
  console.log(`  good/bad 一致: ${pct(agree, both)} (${agree}/${both})`);
  console.log(`  旧good→新bad（自己採点の過大評価）: ${oldGoodNewBad}件`);
  console.log(`  旧bad→新good（独立judgeの方が甘い）: ${oldBadNewGood}件`);

  // --- 保存（再採点 verdict 付き。多数決judge追加や再集計の素地）---
  const judgeSlug = judge.name.replace(/[^a-z0-9]+/gi, "-");
  const outPath = join(here, "data", `rejudge-${judgeSlug}-${basename(inPath)}`);
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n保存: ${outPath}（再採点verdict付き ${records.length}件）`);
}

main().catch((e) => {
  console.error("\neval:rejudge 失敗:", e instanceof Error ? e.message : e);
  console.error("（要 OPENROUTER_API_KEY。judge切替は JUDGE_MODEL / JUDGE_BASE_URL）");
  process.exit(1);
});
