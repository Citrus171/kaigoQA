import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeProvider } from "@/lib/inference";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = join(HERE, "..", "eval", "data", "routing-gold-a.jsonl");
const OUT_PATH = join(HERE, "..", "eval", "data", "headings.json");

type GoldRow = { id: string; referencePoints?: string[] };

async function readGold(): Promise<GoldRow[]> {
  const txt = await readFile(GOLD_PATH, "utf8");
  return txt.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as GoldRow);
}

const SYSTEM = `あなたは介護保険制度のコンテンツ専門家です。
与えられた参考情報（★で始まる要点の列挙）が「どんな質問に答えるための情報か」を、
一般の人が検索で入力しそうな平易な日本語1文（20〜40文字）で表現してください。

ルール:
- 参考情報の内容を正確に反映すること。書かれていない情報を含めない。
- 「介護保険」「要介護」などの専門用語は使ってよい。
- 疑問形ではなく、この文書が答える内容を平叙文で。
- 20〜40文字の1文のみを出力。前置きや説明は不要。`;

async function generateHeading(llm: OpenCodeProvider, id: string, text: string): Promise<string> {
  const prompt = `参考情報:\n${text}`;
  const r = await llm.infer(prompt, SYSTEM);
  return r.text.trim().replace(/^[「『"']|[」』"']$/g, "").slice(0, 80);
}

async function main() {
  const gold = await readGold();
  const corpusGold = gold.filter((g) => (g.referencePoints?.length ?? 0) > 0);
  console.log(`対象: ${corpusGold.length}件`);

  const llm = new OpenCodeProvider();
  const headings: Record<string, string> = {};

  for (let i = 0; i < corpusGold.length; i++) {
    const g = corpusGold[i]!;
    const text = (g.referencePoints ?? []).join("\n");
    process.stdout.write(`\r  進捗 ${i + 1}/${corpusGold.length} [${g.id}]`);
    try {
      headings[g.id] = await generateHeading(llm, g.id, text);
    } catch (e) {
      console.warn(`\n  [warn] ${g.id} 生成失敗: ${(e as Error).message}`);
      headings[g.id] = "";
    }
    if (i > 0 && i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log("");

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(headings, null, 2), "utf8");
  console.log(`[out] ${OUT_PATH} (${Object.keys(headings).length}件)`);

  const sampleKeys = Object.keys(headings).slice(0, 3);
  for (const k of sampleKeys) {
    console.log(`  ${k}: ${headings[k]}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
