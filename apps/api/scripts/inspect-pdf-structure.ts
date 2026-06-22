import { getDocumentProxy } from "unpdf";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_PATH = join(HERE, "..", "eval", "data", "pdf", "000872766.pdf");
const OUT_PATH = join(HERE, "..", "eval", "data", "pdf", "000872766-raw.txt");

// 各ページの先頭に繰り返し現れるヘッダー（リテラル文字列で除去）
const PAGE_HEADERS = [
  "平成31年2月5日Q&A以前平成31年３月15日Q＆A以降",
  "文書名 問番号回答ＱＡ発出時期、文書番号等サービス種別担当課 連番 基準種別 項目 質問",
];

async function main() {
  const buf = await readFile(PDF_PATH);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  console.log("pages:", pdf.numPages);

  const allText: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // item の transform [a,b,c,d,e,f] の f = y座標で行分割を試みる
    const items = content.items as { str: string; transform: number[] }[];
    const text = items.map((it) => it.str).join("");
    let cleaned = text;
    for (const h of PAGE_HEADERS) {
      cleaned = cleaned.split(h).join("");
    }
    allText.push(cleaned);
  }

  const full = allText.join("\n");
  await writeFile(OUT_PATH, full, "utf8");
  console.log(`full text: ${full.length} chars`);

  // 発出時期パターン
  const datePats = full.match(/\d{1,2}[.．]\d{1,2}[.．]\d{1,2}(事務連絡|介護保険最新情報|「平成|の送付)/g);
  console.log(`発出時期パターン数: ${datePats?.length ?? 0}`);

  // 担当課パターン
  const deptPats = full.match(/[^、\n ]{2,15}課[^、\n ]{0,20}（共通）/g);
  console.log(`担当課（共通）パターン数: ${deptPats?.length ?? 0}`);

  // 最初の3エントリを表示
  console.log("\n=== first 800 chars ===");
  console.log(full.slice(0, 800));
}

main().catch((e) => { console.error(e); process.exit(1); });
