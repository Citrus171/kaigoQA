import { getDocumentProxy } from "unpdf";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_PATH = join(HERE, "..", "eval", "data", "pdf", "000872766.pdf");

async function main() {
  const buf = await readFile(PDF_PATH);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  console.log("pages:", pdf.numPages);

  for (let i = 1; i <= 8; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => (it as { str: string }).str).join("");
    console.log(`\n=== page ${i} (chars=${text.length}) ===`);
    console.log(text.slice(0, 600));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
