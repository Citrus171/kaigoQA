// A0(c): kuromoji トークナイズ・スパイク（使い捨て）。
//
// A1 の Hybrid(BM25) 用日本語トークナイザを決める。素朴 bigram は「介護保険→介護/護保/保険」
// のように無意味 n-gram が混じり BM25 の語彙一致を殺すため不可。kuromoji（純JS形態素）が
// 数値/条文/固有名詞を BM25 で語彙一致に使える形（意味ある語彙単位）で残すかを確認する。
//
// 実行: npm run eval:tokenize -w @hybrid/api
//   ※ kuromojin は初回実行時に ipadic 辞書をネットワークから取得・キャッシュする。

import { tokenize } from "kuromojin";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = join(__dirname, "data", "routing-gold-a.jsonl");
const OUT_MD = join(__dirname, "out", "spike-tokenize.md");

// out/40 と同じ missing 13件（handoff 指定）。
const MISSING_IDS = [
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
];

// handoff 指定の代表語（BM25 語彙一致に使えるか確認）。
const PROBE_TERMS = [
  "介護保険",
  "区分支給限度基準額",
  "要介護2",
  "地域区分",
  "19,705単位",
  "1割負担",
  "介護保険法第8条",
  "特定疾病16疾病",
];

type Gold = { id: string; query: string; referencePoints?: string[] };
type Token = Awaited<ReturnType<typeof tokenize>>[number];

function fmt(t: Token): string {
  const pos = t.pos_detail_1 ?? t.pos ?? "?";
  return `${t.surface_form}[${pos}/${t.base_form ?? t.surface_form}]`;
}

function surfaces(tokens: Token[]): string {
  return tokens.map((t) => t.surface_form).join(" / ");
}

async function main() {
  const t0 = Date.now();
  console.log("=== A0(c): kuromoji トークナイズ・スパイク ===");
  console.log("(初回は ipadic 辞書を取得します)\n");

  // 1) 代表語
  console.log("--- 代表語 ---");
  const probeLines: string[] = [];
  for (const term of PROBE_TERMS) {
    const tokens = await tokenize(term);
    console.log(`  ${term} => ${tokens.map(fmt).join(" ")}`);
    const hasNumber = tokens.some((t) => /\d/.test(t.surface_form));
    probeLines.push(`### ${term}`);
    probeLines.push("");
    probeLines.push("- tokens: " + tokens.map(fmt).join(" "));
    probeLines.push(`- surfaces: ${surfaces(tokens)}`);
    probeLines.push(`- 数値を含む token あり: ${hasNumber}`);
    probeLines.push("");
  }

  // 2) missing 13件 の query と referencePoints から数件サンプル
  const txt = await readFile(GOLD_PATH, "utf8");
  const gold = txt
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Gold);
  const missSet = new Set(MISSING_IDS);
  const miss = gold.filter((g) => missSet.has(g.id));
  const sampleN = Math.min(4, miss.length);
  console.log(`\n--- missing ${miss.length}件のサンプル（先頭 ${sampleN} 件）---`);

  const sampleLines: string[] = [];
  for (const g of miss.slice(0, sampleN)) {
    console.log(`\n  [${g.id}] query: ${g.query}`);
    const qTokens = await tokenize(g.query);
    console.log(`    => ${qTokens.map(fmt).join(" ")}`);
    sampleLines.push(`### ${g.id}`);
    sampleLines.push("");
    sampleLines.push(`**query**: ${g.query}`);
    sampleLines.push("");
    sampleLines.push("- " + qTokens.map(fmt).join(" "));
    sampleLines.push("");
    const refs = g.referencePoints ?? [];
    if (refs.length) {
      const refText = refs.slice(0, 3).join("\n");
      const rTokens = await tokenize(refText);
      console.log(`    refs(先頭3) => ${rTokens.map(fmt).join(" ")}`);
      sampleLines.push(`**referencePoints(先頭3)**:`);
      sampleLines.push("");
      sampleLines.push("- " + rTokens.map(fmt).join(" "));
      sampleLines.push("");
    }
  }

  const md: string[] = [];
  md.push("# A0(c): kuromoji トークナイズ・スパイク所見");
  md.push("");
  md.push(`- 日時: ${new Date().toISOString()}`);
  md.push(`- elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  md.push(`- tokenizer: kuromojin (kuromoji@0.1.2 + ipadic)`);
  md.push("");
  md.push("## 観点");
  md.push("");
  md.push("- 数値・条文・固有名詞が BM25 で語彙一致に使える形（意味ある語彙単位）で残るか");
  md.push("- 無意味 n-gram（素朴 bigram の「介護保険→介護/護保/保険」）を回避できているか");
  md.push("");
  md.push("## 代表語のトークナイズ結果");
  md.push("");
  md.push(...probeLines);
  md.push(`## missing 13件のサンプル（先頭 ${sampleN} 件）`);
  md.push("");
  md.push(...sampleLines);

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log(`\n[out] ${OUT_MD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
