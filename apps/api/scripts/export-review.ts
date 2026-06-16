// 実務者レビュー導出（MLOps投資A）。境界ケースを優先抽出して CSV に出力する。
//
// 対象 = borderline=true もしくは system-fact カテゴリ（事実列挙⇄適用の判断が割れる所）。
// 介護実務者がこの CSV をレビュー → label/expected と reviewStatus を更新 → JSONL へ再取込、
// というデータフライホイールの入口。reference 不要で今すぐ回せる。
//
// 出力: eval/data/review-queue.csv（reviewedLabel / reviewerNote 列は実務者記入用に空で出力）。
// 実行: npm run review:export -w @hybrid/api

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTrain, loadGold } from "../eval/data/load";

interface Row {
  id: string;
  set: "train" | "gold";
  query: string;
  currentLabel: string;
  category: string;
  borderline: boolean;
  reviewStatus: string;
  note: string;
}

const target = (category: string, borderline: boolean) =>
  borderline || category === "system-fact";

const rows: Row[] = [
  ...loadTrain()
    .filter((t) => target(t.category, t.borderline))
    .map<Row>((t) => ({
      id: t.id,
      set: "train",
      query: t.query,
      currentLabel: t.label,
      category: t.category,
      borderline: t.borderline,
      reviewStatus: t.reviewStatus,
      note: "",
    })),
  ...loadGold()
    .filter((g) => target(g.category, g.borderline))
    .map<Row>((g) => ({
      id: g.id,
      set: "gold",
      query: g.query,
      currentLabel: g.expected,
      category: g.category,
      borderline: g.borderline,
      reviewStatus: g.reviewStatus,
      note: g.note ?? "",
    })),
];

// CSV エスケープ（カンマ・引用符・改行を含むセルを引用）。
const cell = (v: string | boolean) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const header = [
  "id", "set", "query", "currentLabel", "category", "borderline", "reviewStatus",
  "note", "reviewedLabel", "reviewerNote", // ← 実務者記入用（空）
];
const lines = [
  header.join(","),
  ...rows.map((r) =>
    [
      r.id, r.set, r.query, r.currentLabel, r.category, r.borderline,
      r.reviewStatus, r.note, "", "",
    ].map(cell).join(","),
  ),
];

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "data");
const outPath = join(outDir, "review-queue.csv");
writeFileSync(outPath, lines.join("\n") + "\n");

console.log(`=== review:export ===`);
console.log(`境界ケース ${rows.length} 件を抽出（train ${rows.filter((r) => r.set === "train").length} / gold ${rows.filter((r) => r.set === "gold").length}）`);
console.log(`出力: eval/data/review-queue.csv（reviewedLabel/reviewerNote を実務者が記入）`);
