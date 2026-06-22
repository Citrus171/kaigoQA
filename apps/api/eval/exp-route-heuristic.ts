// (B) escalate 検出ヒューリスティック実験。cloud LLM不使用・純ルール。
// escalate = 個別ケースの数値計算依頼。マーカー: 命令形の計算/金額依頼 + 具体パラメータ。
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
type Item = { id: string; query: string; route_gold: "escalate" | "knowledge_qa" };

// 命令形の「計算/算出して」依頼、または「自己負担額/限度額/料金 … いくら/教えて/計算」
const IMPERATIVE_CALC = /(計算|算出)して(ほしい|ください|くれ)?[。]?$/;
const AMOUNT_REQUEST = /(自己負担額|負担額|限度額|利用料|料金|金額).{0,12}(いくら|教えて|計算|算出|求め)/;
// 具体的な個人パラメータ(数値条件が質問内に与えられている)
const CONCRETE_PARAMS = /(年金収入|月収|年収|収入が).{0,8}\d|(\d+\s*万円)|要介護\d.{0,20}(週|回|日)|\d割ですか|何回ずつ/;

function isEscalate(q: string): boolean {
  const calc = IMPERATIVE_CALC.test(q) || AMOUNT_REQUEST.test(q);
  const params = CONCRETE_PARAMS.test(q);
  // 計算依頼 かつ 具体パラメータ → 個別ケース。または明確な命令計算。
  return (calc && params) || IMPERATIVE_CALC.test(q);
}

async function main() {
  const raw = await readFile(join(HERE, "data", "rag-router-log.jsonl"), "utf8");
  const items: Item[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const fps: Item[] = [], fns: Item[] = [];
  for (const it of items) {
    const pred = isEscalate(it.query) ? "escalate" : "knowledge_qa";
    if (it.route_gold === "escalate") pred === "escalate" ? tp++ : (fn++, fns.push(it));
    else pred === "escalate" ? (fp++, fps.push(it)) : tn++;
  }
  const acc = (tp + tn) / items.length;
  console.log("=== escalate 検出ヒューリスティック ===");
  console.log(`acc=${(acc * 100).toFixed(1)}%  TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`escalate recall=${tp}/${tp + fn}  precision=${tp}/${tp + fp}`);
  console.log("\n-- FN(取りこぼした escalate=危険) --");
  fns.forEach((it) => console.log(`  ${it.id} :: ${it.query}`));
  console.log("\n-- FP(誤って escalate=余分なcloud) --");
  fps.forEach((it) => console.log(`  ${it.id} :: ${it.query}`));
}
main();
