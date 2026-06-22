// (B)classifyRoute の embedding ヒューリスティック化 実験。
// rag-router-log.jsonl(135件, route_gold) を CF bge-m3 で埋め込み、
// leave-one-out でセントロイド分類(escalate vs knowledge_qa)を評価。
// cloud LLM ベースライン 98.5% / escalate recall を比較。OpenCode/OpenRouter 不使用。
import { loadEnv } from "../src/lib/load-env";
loadEnv();
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CfBgeM3EmbedProvider } from "../src/lib/cf-embed";
import { centroid } from "../src/lib/classify-embed";
import { cosine, l2normalize } from "../src/lib/embed";

const HERE = dirname(fileURLToPath(import.meta.url));
type Item = { id: string; query: string; route_gold: "escalate" | "knowledge_qa"; route_pred: string };

async function main() {
  const raw = await readFile(join(HERE, "data", "rag-router-log.jsonl"), "utf8");
  const items: Item[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  const embed = new CfBgeM3EmbedProvider();
  const vecs = (await embed.embed(items.map((i) => i.query))).map((v) => l2normalize(v));

  const idxEsc = items.map((it, i) => (it.route_gold === "escalate" ? i : -1)).filter((i) => i >= 0);
  const idxKqa = items.map((it, i) => (it.route_gold === "knowledge_qa" ? i : -1)).filter((i) => i >= 0);

  // leave-one-out スコア = sim(escalate centroid) - sim(kqa centroid)
  const scores: number[] = items.map((_, i) => {
    const esc = idxEsc.filter((j) => j !== i).map((j) => vecs[j]!);
    const kqa = idxKqa.filter((j) => j !== i).map((j) => vecs[j]!);
    const cEsc = centroid(esc);
    const cKqa = centroid(kqa);
    return cosine(vecs[i]!, cEsc) - cosine(vecs[i]!, cKqa);
  });

  // 閾値スイープ: escalate if score > t。escalate を取りこぼさない方を優先しつつ精度最大。
  const cands = [...scores.map((s) => s - 1e-6), ...scores.map((s) => s + 1e-6)].sort((a, b) => a - b);
  const evalT = (t: number) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    items.forEach((it, i) => {
      const pred = scores[i]! > t ? "escalate" : "knowledge_qa";
      if (it.route_gold === "escalate") pred === "escalate" ? tp++ : fn++;
      else pred === "escalate" ? fp++ : tn++;
    });
    return { t, tp, fp, fn, tn, acc: (tp + tn) / items.length };
  };
  // escalate recall=100% を満たす中で最大精度の t、と 全体精度最大の t を両方出す
  const all = cands.map(evalT);
  const bestAcc = all.reduce((a, b) => (b.acc > a.acc ? b : a));
  const recall100 = all.filter((r) => r.fn === 0).reduce((a, b) => (b.acc > a.acc ? b : a), { acc: -1 } as any);

  const escScores = idxEsc.map((i) => scores[i]!).sort((a, b) => b - a);
  const kqaScoresTop = idxKqa.map((i) => scores[i]!).sort((a, b) => b - a).slice(0, 8);

  console.log("=== (B) embedding route分類 leave-one-out ===");
  console.log("件数:", items.length, "/ escalate:", idxEsc.length, "/ knowledge_qa:", idxKqa.length);
  console.log("cloud LLM ベースライン: 98.5% (escalate recall 5/5想定)");
  console.log("\n-- escalate(gold) の LOO score --");
  idxEsc.forEach((i) => console.log(`  ${items[i]!.id} score=${scores[i]!.toFixed(4)} :: ${items[i]!.query.slice(0, 40)}`));
  console.log("\n-- knowledge_qa(gold) で score 高い上位8(誤検知候補) --");
  idxKqa.map((i) => ({ i, s: scores[i]! })).sort((a, b) => b.s - a.s).slice(0, 8)
    .forEach(({ i, s }) => console.log(`  ${items[i]!.id} score=${s.toFixed(4)} :: ${items[i]!.query.slice(0, 40)}`));
  console.log("\n-- 全体精度最大 --");
  console.log(`  t=${bestAcc.t.toFixed(4)} acc=${(bestAcc.acc * 100).toFixed(1)}% TP=${bestAcc.tp} FP=${bestAcc.fp} FN=${bestAcc.fn} TN=${bestAcc.tn}`);
  console.log("-- escalate recall=100%(FN=0)で最大精度 --");
  if (recall100.acc < 0) console.log("  該当なし(FN=0にできない)");
  else console.log(`  t=${recall100.t.toFixed(4)} acc=${(recall100.acc * 100).toFixed(1)}% TP=${recall100.tp} FP=${recall100.fp} FN=0 TN=${recall100.tn}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
