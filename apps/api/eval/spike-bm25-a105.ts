// A1 §3a: BM25 最小スパイク — A-105/114 の BM25 rank 確認（throwaway）
//
// 135 件の BM25 インデックスを構築し、残 missing 2件（A-105/114）が
// BM25 で top-3 に入るか検証する。A-105 が @3 以内 → full hybrid に進む。
// A-105 が @3 外 → BM25 撤退し代替手法を検討。
//
// 実行: npx tsx eval/spike-bm25-a105.ts

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBm25Index, bm25Search } from "../src/lib/bm25";
import type { Bm25Doc } from "../src/lib/bm25";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "models", "rag", "corpus.json");
const GOLD_PATH = join(__dirname, "data", "routing-gold-a.jsonl");
const OUT_MD = join(__dirname, "out", "spike-bm25-a105.md");

type Gold = { id: string; query: string; category?: string };

const TARGET_IDS = ["gold-A-105", "gold-A-114"];

async function main() {
  const t0 = Date.now();

  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as {
    chunks: Bm25Doc[];
  };
  const docs = corpus.chunks.filter((c) => c.text.length > 0);
  console.log(`corpus: ${docs.length} docs`);

  const gold = (await readFile(GOLD_PATH, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Gold);
  const targets = gold.filter((g) => TARGET_IDS.includes(g.id));

  console.log("building BM25 index...");
  const index = await buildBm25Index(docs);
  console.log(`  vocab size: ${index.idf.size} / avgdl: ${index.avgdl.toFixed(1)}`);

  const md: string[] = [];
  md.push("# A1 §3a: BM25 最小スパイク — A-105/114 rank 確認");
  md.push("");
  md.push(`- 日時: ${new Date().toISOString()}`);
  md.push(`- elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  md.push(`- corpus: ${docs.length} docs / vocab ${index.idf.size} / avgdl ${index.avgdl.toFixed(1)}`);
  md.push(`- BM25 params: k1=${1.5} b=${0.75}`);
  md.push("");

  for (const g of targets) {
    console.log(`\n=== ${g.id} === query: ${g.query}`);
    const top = await bm25Search(index, g.query);
    const rank = top.findIndex((r) => r.srcId === g.id);
    const top5 = top.slice(0, 5);

    console.log(`  BM25 rank: ${rank >= 0 ? rank + 1 : "not in top-135"}`);
    console.log("  BM25 top-5:");
    for (const r of top5) {
      console.log(`    ${r.srcId}: score=${r.score.toFixed(4)}`);
    }

    md.push(`## ${g.id} (${g.category ?? "?"})`);
    md.push("");
    md.push(`**query**: ${g.query}`);
    md.push("");
    md.push(`**BM25 rank**: ${rank >= 0 ? rank + 1 : "not in top-135"}`);
    md.push("");
    md.push("| rank | srcId | score |");
    md.push("|---|---|---|");
    for (let i = 0; i < Math.min(10, top.length); i++) {
      const marker = top[i]!.srcId === g.id ? " ← self" : "";
      md.push(`| ${i + 1} | ${top[i]!.srcId} | ${top[i]!.score.toFixed(4)}${marker} |`);
    }
    md.push("");

    const selfScore = rank >= 0 ? top[rank]!.score : 0;
    const top1Score = top[0]!.score;
    md.push(`- self score: ${selfScore.toFixed(4)} → @1 score: ${top1Score.toFixed(4)}`);
    md.push(`- @1との差: ${(top1Score - selfScore).toFixed(4)}`);
    md.push("");
  }

  // 判定
  const a105 = targets.find((g) => g.id === "gold-A-105")!;
  const a114 = targets.find((g) => g.id === "gold-A-114")!;
  const top105 = await bm25Search(index, a105.query);
  const rank105 = top105.findIndex((r) => r.srcId === a105.id);
  const top114 = await bm25Search(index, a114.query);
  const rank114 = top114.findIndex((r) => r.srcId === a114.id);

  const a105Ok = rank105 >= 0 && rank105 < 3;
  const a114Ok = rank114 >= 0 && rank114 < 3;

  console.log(`\n=== 判定 ===`);
  console.log(`  A-105 BM25 rank=${rank105 >= 0 ? rank105 + 1 : "none"} → @3以内: ${a105Ok}`);
  console.log(`  A-114 BM25 rank=${rank114 >= 0 ? rank114 + 1 : "none"} → @3以内: ${a114Ok}`);

  md.push("## 判定");
  md.push("");
  md.push(`- A-105 BM25 rank: **${rank105 >= 0 ? rank105 + 1 : "none"}** → @3以内: ${a105Ok ? "YES" : "NO"}`);
  md.push(`- A-114 BM25 rank: **${rank114 >= 0 ? rank114 + 1 : "none"}** → @3以内: ${a114Ok ? "YES" : "NO"}`);
  md.push("");
  if (a105Ok) {
    md.push("→ A-105 は BM25 で有効。§3b full hybrid に進む。");
  } else {
    md.push("→ A-105 が BM25 でも @3 に入らない。BM25 撤退し代替手法を検討。");
  }
  if (!a114Ok) {
    md.push("→ A-114 は予想通り BM25 不能。§4 query 拡張等を A1 後で検討。");
  }

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log(`\n[out] ${OUT_MD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
