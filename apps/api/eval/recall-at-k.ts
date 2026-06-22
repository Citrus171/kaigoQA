// A0(b)/A1/real-query: recall@k 計測足場（TypeScript）。
//
// retrieval gold は self-match 構造（1質問=1チャンク）。各 gold 質問 gid を embed →
// pgvector(rag_chunks) から top-K_MAX を取得し、top-k の srcId に gid が含まれれば hit。
//
// RETRIEVAL_MODE=dense (default) | hybrid で dense単独 / hybrid(dense+BM25 RRF) を切替。
// GOLD_FILE=data/real-query-sample.jsonl で実クエリ eval に切替（real_query フィールドを優先）。
// OUT_FILE=out/foo.md で出力先を上書き（省略時は GOLD_FILE 名から自動導出）。
//
// 実行:
//   npm run eval:recall -w @hybrid/api                                        # dense / self-match
//   RETRIEVAL_MODE=hybrid npm run eval:recall -w @hybrid/api                  # hybrid / self-match
//   RETRIEVAL_MODE=hybrid GOLD_FILE=data/real-query-sample.jsonl \
//     npm run eval:recall -w @hybrid/api                                      # hybrid / real-query
//
// 前提: db:up + db:push + db:seed:rag（rag_chunks に 135 件投入済み）。
//   .env: DATABASE_URL / CF_ACCOUNT_ID / CF_API_TOKEN。

import { loadEnv } from "../src/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endDb, nodeDb } from "../src/db/node";
import { retrieveTopK, retrieveHybrid, retrieveHybridWithRerank, type RetrievedChunk } from "../src/lib/rag";
import { CfBgeM3EmbedProvider } from "../src/lib/cf-embed";
import { CfBgeRerankProvider } from "../src/lib/cf-rerank";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GOLD_FILE_ENV = process.env.GOLD_FILE; // e.g. "data/real-query-sample.jsonl"
const GOLD_PATH = join(__dirname, GOLD_FILE_ENV ?? "data/routing-gold-a.jsonl");

// OUT_FILE を GOLD_FILE 名から自動導出。デフォルト gold → recall-at-k.md のまま。
const defaultOutFile = GOLD_FILE_ENV
  ? `out/${GOLD_FILE_ENV.replace(/^data\//, "").replace(/\.jsonl$/, "")}-recall.md`
  : "out/recall-at-k.md";
const OUT_MD = join(__dirname, process.env.OUT_FILE ?? defaultOutFile);

const KS = [1, 3, 5, 8];
const K_MAX = KS[KS.length - 1]!;

const RETRIEVAL_MODE = process.env.RETRIEVAL_MODE ?? "dense";
const RRF_C = Number(process.env.RRF_C ?? 10);
const RRF_W_DENSE = Number(process.env.RRF_W_DENSE ?? 5);
const RRF_W_BM25 = Number(process.env.RRF_W_BM25 ?? 1);
const USE_RERANK = process.env.RERANK === "true";
const RERANK_CANDIDATES = Number(process.env.RERANK_CANDIDATES ?? 20);

// out/40 と同じ missing 13件（self-match 回収分析の参照用・ID は handoff 指定）。
// 注意: gold-A-071 修正後、実態は top-8 回収不可が 12 件に減っているが、
// 本リストは before/after の固定比較基準として 13 件のまま維持する。
const MISSING_IDS = new Set([
  "gold-A-020",
  "gold-A-021",
  "gold-A-038",
  "gold-A-042",
  "gold-A-046",
  "gold-A-055",
  "gold-A-056",
  "gold-A-071",
  "gold-A-105",
  "gold-A-112",
  "gold-A-114",
  "gold-A-118",
  "gold-calc-013",
]);

type Gold = {
  id: string;
  query: string;
  real_query?: string; // real-query eval 用（存在すれば retrieval クエリとして優先）
  category?: string;
  referencePoints?: string[];
};

type Row = {
  id: string;
  category: string;
  query: string;
  foundK: number | null;
  topIds: string[];
  top1Score: number;
};

async function readGold(path: string): Promise<Gold[]> {
  const txt = await readFile(path, "utf8");
  return txt
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Gold);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const reranker = USE_RERANK ? new CfBgeRerankProvider() : null;

async function retrieve(
  db: ReturnType<typeof nodeDb>,
  query: string,
  k: number,
  embed: CfBgeM3EmbedProvider,
): Promise<RetrievedChunk[]> {
  if (RETRIEVAL_MODE === "hybrid" && reranker) {
    return retrieveHybridWithRerank(db, query, reranker, k, RERANK_CANDIDATES, RRF_C, RRF_W_DENSE, RRF_W_BM25);
  }
  if (RETRIEVAL_MODE === "hybrid") {
    return retrieveHybrid(db, query, k, 15, RRF_C, RRF_W_DENSE, RRF_W_BM25);
  }
  return retrieveTopK(db, query, k, embed);
}

async function main() {
  const t0 = Date.now();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL が必要です（.env または環境変数）");

  const db = nodeDb(dbUrl);
  const embed = new CfBgeM3EmbedProvider();

  const gold = await readGold(GOLD_PATH);
  const modeLabel =
    RETRIEVAL_MODE === "hybrid" && USE_RERANK
      ? `hybrid+rerank(dense+bm25 RRF c=${RRF_C} → ${reranker!.name}, candidates=${RERANK_CANDIDATES})`
      : RETRIEVAL_MODE === "hybrid"
        ? `hybrid(dense+bm25, RRF c=${RRF_C})`
        : `dense(${embed.name})`;
  console.log(`gold: ${gold.length} 件 / K_MAX=${K_MAX} / mode=${modeLabel}`);

  const rows: Row[] = [];
  for (let i = 0; i < gold.length; i++) {
    const g = gold[i]!;
    const retrieveQuery = g.real_query ?? g.query;
    let top: RetrievedChunk[];
    try {
      top = await retrieve(db, retrieveQuery, K_MAX, embed);
    } catch (e) {
      console.warn(`  [warn] ${g.id} retrieve 失敗: ${(e as Error).message}`);
      rows.push({
        id: g.id,
        category: g.category ?? "",
        query: retrieveQuery,
        foundK: null,
        topIds: [],
        top1Score: 0,
      });
      if ((i + 1) % 10 === 0 || i + 1 === gold.length) {
        console.log(`  ...${i + 1}/${gold.length}`);
      }
      continue;
    }
    const topIds = top.map((t) => t.srcId);
    let foundK: number | null = null;
    for (let r = 0; r < topIds.length; r++) {
      if (topIds[r] === g.id) {
        foundK = r + 1;
        break;
      }
    }
    rows.push({
      id: g.id,
      category: g.category ?? "",
      query: retrieveQuery,
      foundK,
      topIds,
      top1Score: top[0]?.score ?? 0,
    });
    if ((i + 1) % 10 === 0 || i + 1 === gold.length) {
      console.log(`  ...${i + 1}/${gold.length}`);
    }
  }

  const allN = rows.length;
  // MISSING_IDS セクションは self-match gold（routing-gold-a.jsonl）でのみ意味を持つ。
  // real-query gold など対象 ID が存在しない場合は出力をスキップ。
  const missRows = rows.filter((r) => MISSING_IDS.has(r.id));
  const missN = missRows.length;
  const showMissSection = missN > 0;

  const recallAll = KS.map((k) => ({
    k,
    hit: rows.filter((r) => r.foundK !== null && r.foundK <= k).length,
    n: allN,
  }));
  const recallMiss = KS.map((k) => ({
    k,
    hit: missRows.filter((r) => r.foundK !== null && r.foundK <= k).length,
    n: missN,
  }));

  console.log("\n=== recall@k (全件) ===");
  for (const r of recallAll) console.log(`  @${r.k}: ${r.hit}/${r.n} = ${pct(r.hit / r.n)}`);

  if (showMissSection) {
    console.log("\n=== recall@k (固定比較セット: out/40 missing 13件) ===");
    for (const r of recallMiss) console.log(`  @${r.k}: ${r.hit}/${r.n} = ${pct(r.hit / r.n)}`);
    console.log(`\n=== missing ${missN}件 (固定比較セット: out/40 missing 13件) 詳細 ===`);
    for (const r of missRows) {
      const fk = r.foundK ? `top-${r.foundK}` : `not in top-${K_MAX}`;
      console.log(
        `  ${r.id} cat=${r.category} found=${fk} top1=${r.top1Score.toFixed(3)} top5=${r.topIds.slice(0, 5).join(",")}`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const md: string[] = [];
  md.push(`# recall@k 計測 — ${modeLabel}`);
  md.push("");
  md.push(`- 日時: ${new Date().toISOString()}`);
  md.push(`- elapsed: ${elapsed}s`);
  md.push(
    `- gold: ${allN}件 / K_MAX=${K_MAX} / mode=${modeLabel}`,
  );
  md.push(
    `- RRF: w(dense)=${RRF_W_DENSE} w(bm25)=${RRF_W_BM25} c=${RRF_C}`,
  );
  md.push("");
  md.push("## recall@k（全件）");
  md.push("");
  md.push("| k | hit | n | recall |");
  md.push("|---|---|---|---|");
  for (const r of recallAll) md.push(`| ${r.k} | ${r.hit} | ${r.n} | ${pct(r.hit / r.n)} |`);
  md.push("");
  if (showMissSection) {
    md.push("## recall@k（固定比較セット: out/40 missing 13件）");
    md.push("");
    md.push("| k | hit | n | recall |");
    md.push("|---|---|---|---|");
    for (const r of recallMiss) md.push(`| ${r.k} | ${r.hit} | ${r.n} | ${pct(r.hit / r.n)} |`);
    md.push("");
    md.push(`### missing ${missN}件 詳細`);
    md.push("");
    md.push("| id | category | found at | top1 score | top-5 ids |");
    md.push("|---|---|---|---|---|");
    for (const r of missRows) {
      const fk = r.foundK ? `top-${r.foundK}` : `not in top-${K_MAX}`;
      md.push(
        `| ${r.id} | ${r.category} | ${fk} | ${r.top1Score.toFixed(3)} | ${r.topIds.slice(0, 5).join(", ")} |`,
      );
    }
    md.push("");
  }

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log(`\n[out] ${OUT_MD}`);

  await endDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
