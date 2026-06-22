// PDF ingestion: 介護サービス関係Q&A集（mhlw 000872766.pdf）をチャンク化する。
//
// B1 改善点の実装:
//   1. チャンク見出し前置: 各Q&Aの「項目」列を口語見出しとして chunk 本文の先頭に置く
//   2. 表保持: pdfjs-dist(unpdf) の text item 位置情報(x座標)で列を復元し、
//      項目/質問/回答を分離。表除去ではなく表構造を活用。
//   3. メタデータ付与: 発出時期を srcId と chunk 末尾に埋め込み（法改正トレーサビリティ）
//   5. ライブラリ選定: unpdf（pdfjs-dist wrapper）= 構造保持・表も取れる
//
// 出力: eval/data/pdf/mhlw-qa-chunks.jsonl（1行1チャンク・embedding前）
//   {srcId, heading, question, answer, source, date, text}
//
// 実行: npx tsx scripts/ingest-pdf-mhlw-qa.ts

import { getDocumentProxy } from "unpdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_PATH = join(HERE, "..", "eval", "data", "pdf", "000872766.pdf");
const OUT_DIR = join(HERE, "..", "eval", "data", "pdf");
const OUT_PATH = join(OUT_DIR, "mhlw-qa-chunks.jsonl");

// 列の x 座標境界（inspect-pdf-columns.ts で実測）
// 担当課: x<80, 連番: 80-98, サービス種別: 98-210, 基準種別: 210-238,
// 項目: 238-310, 質問: 310-520, 回答: 520-725, 発出時期: 725-798, 文書番号: >=798
type Column = "dept" | "seq" | "service" | "criteria" | "item" | "question" | "answer" | "date" | "docno";

function classifyColumn(x: number): Column {
  if (x < 80) return "dept";
  if (x < 98) return "seq";
  if (x < 210) return "service";
  if (x < 238) return "criteria";
  if (x < 310) return "item";
  if (x < 520) return "question";
  if (x < 725) return "answer";
  if (x < 798) return "date";
  return "docno";
}

type TextItem = { str: string; x: number; y: number };
type RawEntry = {
  dept: string;
  seq: string;
  service: string;
  criteria: string;
  item: string;
  question: string;
  answer: string;
  date: string;
  docno: string;
  page: number;
};

async function main() {
  const buf = await readFile(PDF_PATH);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  console.log(`pages: ${pdf.numPages}`);

  const entries: RawEntry[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as { str: string; transform: number[] }[])
      .filter((it) => it.str.trim())
      .map((it) => ({
        str: it.str,
        x: it.transform[4]!,
        y: Math.round(it.transform[5]!),
      }));

    // y座標で行グループ化（同一行 = yが同じ±2）
    const rowMap = new Map<number, TextItem[]>();
    for (const it of items) {
      const yKey = Math.round(it.y / 3) * 3; // 3px 単位で丸めて近接行を統合
      if (!rowMap.has(yKey)) rowMap.set(yKey, []);
      rowMap.get(yKey)!.push(it);
    }

    // 行を y 降順（上から下）にソート
    const sortedRows = [...rowMap.entries()].sort((a, b) => b[0] - a[0]);

    // エントリ開始行 = service列(x≈99) と criteria列(x≈212) の両方がある行
    // これを境界にしてエントリを分割
    const columns: Column[] = ["dept", "seq", "service", "criteria", "item", "question", "answer", "date", "docno"];
    const colText: Record<Column, string[]> = {
      dept: [], seq: [], service: [], criteria: [],
      item: [], question: [], answer: [], date: [], docno: [],
    };

    for (const [, rowItems] of sortedRows) {
      rowItems.sort((a, b) => a.x - b.x);
      const cols = new Set(rowItems.map((it) => classifyColumn(it.x)));

      // エントリ開始行の検出: service + criteria が両方ある行
      const isEntryStart = cols.has("service") && cols.has("criteria");

      if (isEntryStart && (colText.item.length > 0 || colText.question.length > 0)) {
        // 前のエントリを確定
        entries.push({
          dept: colText.dept.join("").trim(),
          seq: colText.seq.join("").trim(),
          service: colText.service.join("").trim(),
          criteria: colText.criteria.join("").trim(),
          item: colText.item.join("").trim(),
          question: colText.question.join("").trim(),
          answer: colText.answer.join("").trim(),
          date: colText.date.join("").trim(),
          docno: colText.docno.join("").trim(),
          page: p,
        });
        for (const c of columns) colText[c] = [];
      }

      for (const it of rowItems) {
        const col = classifyColumn(it.x);
        colText[col].push(it.str);
      }
    }

    // ページ末尾のエントリを確定
    if (colText.item.length > 0 || colText.question.length > 0) {
      entries.push({
        dept: colText.dept.join("").trim(),
        seq: colText.seq.join("").trim(),
        service: colText.service.join("").trim(),
        criteria: colText.criteria.join("").trim(),
        item: colText.item.join("").trim(),
        question: colText.question.join("").trim(),
        answer: colText.answer.join("").trim(),
        date: colText.date.join("").trim(),
        docno: colText.docno.join("").trim(),
        page: p,
      });
    }

    if (p % 20 === 0) console.log(`  ...page ${p}/${pdf.numPages} (entries so far: ${entries.length})`);
  }

  console.log(`\nraw entries: ${entries.length}`);

  // フィルタ: item または question が空のエントリを除外（ヘッダー残り等）
  const valid = entries.filter(
    (e) => e.item.length > 0 && e.question.length > 0 && e.answer.length > 0,
  );
  console.log(`valid entries (item+question+answer 非空): ${valid.length}`);

  // 重複除外: 同一 item+question のエントリは最初のみ
  const seen = new Set<string>();
  const unique = valid.filter((e) => {
    const key = e.item + "|" + e.question.slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`unique entries: ${unique.length}`);

  // チャンク化: srcId + text を生成
  const chunks = unique.map((e, i) => {
    const seqNum = e.seq.replace(/\D/g, "") || String(i + 1);
    const srcId = `mhlw-qa-${seqNum.padStart(4, "0")}`;
    // 改善点1: 項目（見出し）を本文先頭に前置
    // 改善点3: 発出時期をメタデータとして文末に付与
    const text = `【${e.item}】\n質問: ${e.question}\n回答: ${e.answer}\n（出典: 介護サービス関係Q&A集 ${e.date}${e.docno}）`;
    return {
      srcId,
      heading: e.item,
      question: e.question,
      answer: e.answer,
      source: "介護サービス関係Q&A集",
      date: e.date,
      text,
      page: e.page,
    };
  });

  // srcId 重複チェック
  const idCounts = new Map<string, number>();
  for (const c of chunks) idCounts.set(c.srcId, (idCounts.get(c.srcId) ?? 0) + 1);
  const dupes = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    console.warn(`srcId 重複: ${dupes.length}件 → 連番にインデックス付与で解決`);
    const idMap = new Map<string, number>();
    for (const c of chunks) {
      const base = c.srcId;
      const n = idMap.get(base) ?? 0;
      idMap.set(base, n + 1);
      if (n > 0) c.srcId = `${base}-${n}`;
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const lines = chunks.map((c) => JSON.stringify(c));
  await writeFile(OUT_PATH, lines.join("\n") + "\n", "utf8");
  console.log(`\n[out] ${OUT_PATH} (${chunks.length} chunks)`);

  // サンプル表示
  console.log("\n=== sample chunks ===");
  for (const c of chunks.slice(0, 3)) {
    console.log(`\n--- ${c.srcId} (page ${c.page}) ---`);
    console.log(`heading: ${c.heading}`);
    console.log(`question: ${c.question.slice(0, 80)}...`);
    console.log(`answer: ${c.answer.slice(0, 80)}...`);
    console.log(`date: ${c.date}`);
  }

  // ユーザーの質問に該当するチャンクを確認
  const target = chunks.find((c) => c.question.includes("常勤換算方法により算定される従業者が出張"));
  if (target) {
    console.log(`\n=== TARGET CHUNK (ユーザー質問に対応) ===`);
    console.log(`srcId: ${target.srcId}`);
    console.log(`heading: ${target.heading}`);
    console.log(`text (first 200): ${target.text.slice(0, 200)}`);
  } else {
    console.log("\n⚠️ TARGET CHUNK NOT FOUND (常勤換算の質問が見つかりません)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
