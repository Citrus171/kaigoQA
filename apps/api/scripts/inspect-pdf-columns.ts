import { getDocumentProxy } from "unpdf";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_PATH = join(HERE, "..", "eval", "data", "pdf", "000872766.pdf");

async function main() {
  const buf = await readFile(PDF_PATH);
  const pdf = await getDocumentProxy(new Uint8Array(buf));

  // page 1 の text item の位置情報を確認
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const items = content.items as { str: string; transform: number[]; width?: number }[];

  // transform: [a,b,c,d,e,f] → e=x, f=y
  // y座標で行をグループ化、x座標で列を推定
  const rows = new Map<number, { x: number; str: string }[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]!);
    const x = it.transform[4]!;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push({ x, str: it.str });
  }

  // y降順（上から下）で表示
  const sortedYs = [...rows.keys()].sort((a, b) => b - a);
  console.log(`page 1: ${sortedYs.length} rows\n`);

  for (const y of sortedYs.slice(0, 25)) {
    const row = rows.get(y)!.sort((a, b) => a.x - b.x);
    const cols = row.map((r) => `x=${r.x.toFixed(0)}:"${r.str}"`);
    console.log(`y=${y}: ${cols.join(" | ")}`);
  }

  // x座標の分布（列の境界を推定）
  const allX = items.filter((it) => it.str.trim()).map((it) => it.transform[4]!);
  const xBins = new Map<number, number>();
  for (const x of allX) {
    const bin = Math.round(x / 10) * 10;
    xBins.set(bin, (xBins.get(bin) ?? 0) + 1);
  }
  console.log("\n=== x coordinate distribution (top 15) ===");
  [...xBins.entries()].sort((a, b) => a[0] - b[0]).slice(0, 15).forEach(([x, n]) => {
    console.log(`  x=${x}: ${n} items ${"#".repeat(Math.min(n, 50))}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
