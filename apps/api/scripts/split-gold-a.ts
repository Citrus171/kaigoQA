// Dataset A を dev / holdout に決定的・層化分割する（本番閾値検証フロー step4）。
//
// 設計（2026-06-18 確定）:
//   - train(routing-train) = 分類器プロトタイプ専用。閾値 tune には使わない。
//   - A-dev   = 閾値を決定する split（eval-routing の動作点選択はここで行う）。
//   - A-holdout = 最終確認専用・凍結。閾値調整に一切使わない（peek 禁止）。
//   ※ gold-22(Dataset B) は A の holdout ではない。A の holdout は本 split が作る。
//
// 分割は (category × expected) セル単位の層化で、決定的（乱数なし・seed不要）:
//   各セルを id 昇順に並べ、セル内 index % 5 == 2 の項目を holdout（約20%）、残りを dev。
//   id が安定キーなので再実行・環境差で結果が一致する（再現性＝監査可能）。
//   サイズ <3 のセルは holdout 0（少なすぎる層は分けない）＝dev に寄せる。
//
// 実行: npm run split:gold-a -w @hybrid/api
//   入力 : apps/api/eval/data/routing-gold-a.jsonl（承認済み gold A）
//   出力 : apps/api/eval/data/routing-gold-a-dev.jsonl / routing-gold-a-holdout.jsonl
// 評価 : EVAL_GOLD_FILE=routing-gold-a-dev.jsonl npm run eval:routing  → 動作点決定
//        EVAL_GOLD_FILE=routing-gold-a-holdout.jsonl で固定閾値の最終確認（調整禁止）。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadGold, type GoldCase } from "../eval/data/load";

const HOLDOUT_OFFSET = 2; // セル内 index % 5 == 2 を holdout に
const dataDir = fileURLToPath(new URL("../eval/data/", import.meta.url));

const gold = loadGold("routing-gold-a.jsonl");

// (category, expected) セルへ層化。
const cells = new Map<string, GoldCase[]>();
for (const g of gold) {
  const key = `${g.category}|${g.expected}`;
  (cells.get(key) ?? cells.set(key, []).get(key)!).push(g);
}

const dev: GoldCase[] = [];
const holdout: GoldCase[] = [];
for (const [, items] of cells) {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  sorted.forEach((g, i) => {
    // サイズ<3 のセルは分けない（全部 dev）。
    if (sorted.length >= 3 && i % 5 === HOLDOUT_OFFSET) holdout.push(g);
    else dev.push(g);
  });
}

const byId = (a: GoldCase, b: GoldCase) => a.id.localeCompare(b.id);
dev.sort(byId);
holdout.sort(byId);

const dump = (rows: GoldCase[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(dataDir, "routing-gold-a-dev.jsonl"), dump(dev));
writeFileSync(join(dataDir, "routing-gold-a-holdout.jsonl"), dump(holdout));

// サマリ（セル別 dev/holdout 件数）。
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
console.log(`=== split:gold-a （A=${gold.length} → dev=${dev.length} / holdout=${holdout.length}, holdout=${pct(holdout.length, gold.length)}%）===`);
const cellKeys = [...cells.keys()].sort();
for (const k of cellKeys) {
  const n = cells.get(k)!.length;
  const h = holdout.filter((g) => `${g.category}|${g.expected}` === k).length;
  console.log(`  ${k}: n=${n} dev=${n - h} holdout=${h}`);
}
const devEdge = dev.filter((g) => g.expected === "edge").length;
const hoEdge = holdout.filter((g) => g.expected === "edge").length;
console.log(`  edge比: dev=${pct(devEdge, dev.length)}% holdout=${pct(hoEdge, holdout.length)}%（全体と近いほど層化良好）`);
console.log("  出力: routing-gold-a-dev.jsonl / routing-gold-a-holdout.jsonl");
