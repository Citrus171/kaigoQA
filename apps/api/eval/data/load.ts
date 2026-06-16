// ルーティングデータ（train / gold）の単一の真実 = JSONL + 検証付きローダ（MLOps投資A）。
//
// 旧: train を src/lib/routing-prototypes.ts、gold を eval/routing-gold.ts に TS リテラル直書き。
// 新: データ形状（JSONL）に分離し、diff/追記/レビューしやすく・将来 Python からも読める形に。
//   各行は安定 id / provenance / reviewStatus / borderline のメタを持つ（実務者レビューの土台）。
//
// 検証は scripts/check-data.ts（npm run check:data）= スキーマ・リーク・重複・balance。
// ここではロード時に zod でスキーマ検証する（壊れた行は即 throw）。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type Tier = "edge" | "cloud";

const tier = z.enum(["edge", "cloud"]);
// 出自: synthetic=手作業作成 / real-traffic=実トラフィックから収集（ライブ後のデータフライホイール）。
const provenance = z.enum(["synthetic", "real-traffic"]);
// レビュー状態: pending=暫定（要実務者） / approved=sign-off済 / rejected=要修正。
const reviewStatus = z.enum(["pending", "approved", "rejected"]);

const baseSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  category: z.string().min(1),
  provenance,
  reviewStatus,
  // 境界ケース（事実列挙⇄適用の判断が割れる）。実務者レビューの優先対象。
  borderline: z.boolean(),
});

export const trainSchema = baseSchema.extend({ label: tier });
export const goldSchema = baseSchema.extend({
  expected: tier,
  note: z.string().optional(),
});

export type TrainExample = z.infer<typeof trainSchema>;
export type GoldCase = z.infer<typeof goldSchema>;

const dataDir = dirname(fileURLToPath(import.meta.url));

function readJsonl(file: string): unknown[] {
  const text = readFileSync(join(dataDir, file), "utf8");
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, n }) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${file}:${n} JSON parse 失敗: ${line.slice(0, 60)}`);
      }
    });
}

export function loadTrain(): TrainExample[] {
  return readJsonl("routing-train.jsonl").map((o) => trainSchema.parse(o));
}

export function loadGold(): GoldCase[] {
  return readJsonl("routing-gold.jsonl").map((o) => goldSchema.parse(o));
}
