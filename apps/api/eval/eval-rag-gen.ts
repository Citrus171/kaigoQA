// RAG + 生成品質 eval（cloud のみ）。
//
// 実クエリ 26件に対して:
//   retrieval(hybrid k=5) → classifyRoute → buildSystemPrompt → cloud 生成 → LLM-as-Judge
// を回し、「retrieval が取れている前提で cloud 生成は正しいか」を測る。
//
// 注意: 生成(deepseek-v4-flash)と judge(deepseek-v4-flash)が同一モデル = 自己採点バイアス。
//   cloud 回答の good 率は楽観に膨らむ傾向。絶対値より同条件での比較・推移に使う。
//   referencePoints が存在する件のみ参照採点（存在しない件は従来採点にフォールバック）。
//
// 実行:
//   RETRIEVAL_MODE=hybrid npm run eval:rag-gen -w @hybrid/api
//
// 前提: db:up + db:seed:rag / .env: DATABASE_URL / CF_ACCOUNT_ID / CF_API_TOKEN / OPENCODE_API_KEY

import { loadEnv } from "../src/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endDb, nodeDb } from "../src/db/node";
import { retrieveHybrid } from "../src/lib/rag";
import { OpenCodeProvider } from "../src/lib/inference";
import { classifyRoute, buildSystemPrompt } from "../src/lib/capability-router";
import { judgeAnswer, isGoodAnswer, type JudgeVerdict, type FailureCategory } from "./judge";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_QUERY_PATH = join(__dirname, "data", "real-query-sample.jsonl");
const GOLD_PATH = join(__dirname, "data", "routing-gold-a.jsonl");
const OUT_MD = join(__dirname, "out", "eval-rag-gen.md");
const OUT_JSONL = join(__dirname, "out", "eval-rag-gen-answers.jsonl");

type RealQueryItem = { id: string; category: string; real_query: string };
type GoldItem = { id: string; referencePoints?: string[] };

type Row = {
  id: string;
  category: string;
  real_query: string;
  route: string;
  retrievedN: number;
  topScore: number;
  topIds: string[]; // top-5 の srcId（retrieval ズレ診断用）
  correctRank: number; // 正解チャンク(id)が top-5 で何位か。-1=圏外
  answer: string;
  verdict: JudgeVerdict | null;
  genFailed: boolean;
};

async function readJsonl<T>(path: string): Promise<T[]> {
  const txt = await readFile(path, "utf8");
  return txt.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const t0 = Date.now();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL が必要です");

  const db = nodeDb(dbUrl);
  const cloud = new OpenCodeProvider();
  const judge = new OpenCodeProvider();

  const realItems = await readJsonl<RealQueryItem>(REAL_QUERY_PATH);
  const goldItems = await readJsonl<GoldItem>(GOLD_PATH);
  const refMap = new Map(goldItems.map((g) => [g.id, g.referencePoints ?? []]));

  console.log(`=== RAG + 生成品質 eval ===`);
  console.log(`対象: ${realItems.length}件 / generator=${cloud.name} / judge=${cloud.name}(自己採点注意)`);
  console.log(`retrieval: hybrid(RRF w5:1 c=10) k=5\n`);

  const rows: Row[] = [];
  for (let i = 0; i < realItems.length; i++) {
    const item = realItems[i]!;
    process.stdout.write(`\r  進捗 ${i + 1}/${realItems.length} [${item.id}]`);

    // retrieval
    let hits: Awaited<ReturnType<typeof retrieveHybrid>>;
    try {
      hits = await retrieveHybrid(db, item.real_query, 5, 15, 10, 5, 1);
    } catch (e) {
      console.warn(`\n  [warn] ${item.id} retrieval 失敗: ${(e as Error).message}`);
      rows.push({ id: item.id, category: item.category, real_query: item.real_query,
        route: "retrieval-failed", retrievedN: 0, topScore: 0, topIds: [], correctRank: -1,
        answer: "", verdict: null, genFailed: true });
      continue;
    }
    const topIds = hits.map((h) => h.srcId);
    const correctRank = topIds.indexOf(item.id); // -1=圏外

    // classifyRoute + buildSystemPrompt + 生成
    let answer = "";
    let route = "unknown";
    let genFailed = false;
    try {
      const decision = await classifyRoute(item.real_query, cloud);
      route = decision.route;
      const system = buildSystemPrompt(decision.route, hits.map((h) => h.text));
      const r = await cloud.infer(item.real_query, system);
      answer = r.text;
    } catch (e) {
      console.warn(`\n  [warn] ${item.id} 生成失敗: ${(e as Error).message}`);
      genFailed = true;
    }

    // judge
    let verdict: JudgeVerdict | null = null;
    if (!genFailed && answer.trim()) {
      try {
        const refs = refMap.get(item.id) ?? [];
        verdict = await judgeAnswer(judge, item.real_query, answer, refs.length > 0 ? refs : undefined);
      } catch {
        verdict = { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
      }
    }

    rows.push({
      id: item.id, category: item.category, real_query: item.real_query,
      route, retrievedN: hits.length, topScore: hits[0]?.score ?? 0,
      topIds, correctRank, answer, verdict, genFailed,
    });
  }
  process.stdout.write("\n");

  // 集計
  const judged = rows.filter((r) => r.verdict !== null);
  const good = judged.filter((r) => isGoodAnswer(r.verdict!));
  const cats: Record<FailureCategory, number> = { ok: 0, hallucination: 0, partial: 0, refusal: 0, overreach: 0, outdated: 0 };
  judged.forEach((r) => { cats[r.verdict!.category]++; });

  const catBreakdown = (Object.entries(cats) as [FailureCategory, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const routeCounts: Record<string, number> = {};
  rows.forEach((r) => { routeCounts[r.route] = (routeCounts[r.route] ?? 0) + 1; });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`\n=== 結果 ===`);
  console.log(`judged: ${judged.length}/${rows.length}`);
  console.log(`good: ${good.length}/${judged.length} = ${pct(good.length, judged.length)}`);
  console.log(`カテゴリ内訳: ${catBreakdown.map(([k, n]) => `${k}=${n}`).join(" / ")}`);
  console.log(`route分布: ${Object.entries(routeCounts).map(([k, n]) => `${k}=${n}`).join(" / ")}`);

  // 件別ログ
  console.log("\n=== 件別 ===");
  rows.forEach((r) => {
    const v = r.verdict;
    const flag = v ? (isGoodAnswer(v) ? "✓" : "✗") : "E";
    console.log(`  ${flag} ${r.id} [${r.route}] top1=${r.topScore.toFixed(3)} cat=${v?.category ?? "failed"} reason=${v?.reason ?? r.genFailed ? "gen_failed" : ""}`);
  });

  // MD 出力
  const md: string[] = [];
  md.push("# RAG + 生成品質 eval");
  md.push("");
  md.push(`- 日時: ${new Date().toISOString()}`);
  md.push(`- elapsed: ${elapsed}s`);
  md.push(`- 対象: 実クエリ ${rows.length}件 / generator=${cloud.name} / judge=${cloud.name}`);
  md.push(`- retrieval: hybrid(RRF w5:1 c=10) k=5`);
  md.push(`- **注意: 生成と judge が同一モデル = 自己採点バイアスあり（cloud good率は楽観側）**`);
  md.push("");
  md.push("## サマリー");
  md.push("");
  md.push(`| 指標 | 値 |`);
  md.push(`|---|---|`);
  md.push(`| good rate | ${pct(good.length, judged.length)} (${good.length}/${judged.length}) |`);
  md.push(`| judged | ${judged.length}/${rows.length} |`);
  md.push(`| gen_failed | ${rows.filter((r) => r.genFailed).length} |`);
  catBreakdown.forEach(([k, n]) => md.push(`| ${k} | ${n} (${pct(n, judged.length)}) |`));
  md.push("");
  md.push("## route 分布");
  md.push("");
  md.push("| route | n |");
  md.push("|---|---|");
  Object.entries(routeCounts).forEach(([k, n]) => md.push(`| ${k} | ${n} |`));
  md.push("");
  md.push("## 件別");
  md.push("");
  md.push("| id | category | route | top1 score | 正解順位 | top-1 | verdict | reason |");
  md.push("|---|---|---|---|---|---|---|---|");
  rows.forEach((r) => {
    const v = r.verdict;
    const flag = v ? (isGoodAnswer(v) ? "good" : v.category) : "failed";
    const rankLabel = r.correctRank === -1 ? "圏外" : `top-${r.correctRank + 1}`;
    const top1 = r.topIds[0] ?? "—";
    const top1Mark = top1 === r.id ? "正解" : top1;
    md.push(`| ${r.id} | ${r.category} | ${r.route} | ${r.topScore.toFixed(3)} | ${rankLabel} | ${top1Mark} | ${flag} | ${v?.reason ?? ""} |`);
  });
  md.push("");

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log(`\n[out] ${OUT_MD}`);

  // raw answer を JSONL で別途保存（partial の原因を本文で精査するため）。
  const jsonlLines = rows.map((r) => JSON.stringify({
    id: r.id, category: r.category, real_query: r.real_query, route: r.route,
    topIds: r.topIds, correctRank: r.correctRank, topScore: r.topScore,
    verdict: r.verdict, answer: r.answer,
  }));
  await writeFile(OUT_JSONL, jsonlLines.join("\n"), "utf8");
  console.log(`[out] ${OUT_JSONL}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
