// (A) classifyRoute を edge(Workers AI/Gemma)で実行し精度測定。OpenCode/OpenRouter不使用。
import { loadEnv } from "../src/lib/load-env";
loadEnv();
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRoute } from "../src/lib/capability-router";
import { WorkersAiProvider } from "../src/lib/inference";
const HERE = dirname(fileURLToPath(import.meta.url));
type Item = { id: string; query: string; route_gold: "escalate" | "knowledge_qa" };

async function mapLimit<T, R>(arr: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < arr.length) { const i = idx++; out[i] = await fn(arr[i]!, i); }
  }));
  return out;
}

async function main() {
  const raw = await readFile(join(HERE, "data", "rag-router-log.jsonl"), "utf8");
  const items: Item[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  const edge = new WorkersAiProvider();
  const t0 = Date.now();
  const lat: number[] = [];
  const preds = await mapLimit(items, 4, async (it) => {
    const s = Date.now();
    try { const d = await classifyRoute(it.query, edge); lat.push(Date.now() - s); return d.route; }
    catch (e) { lat.push(Date.now() - s); return "ERROR"; }
  });
  let tp = 0, fp = 0, fn = 0, tn = 0, err = 0; const fns: Item[] = [], fps: Item[] = [];
  items.forEach((it, i) => {
    const p = preds[i];
    if (p === "ERROR") { err++; return; }
    if (it.route_gold === "escalate") p === "escalate" ? tp++ : (fn++, fns.push(it));
    else p === "escalate" ? (fp++, fps.push(it)) : tn++;
  });
  const n = items.length - err;
  lat.sort((a, b) => a - b);
  console.log("=== (A) edge(Gemma) classifyRoute ===");
  console.log(`model=${process.env.WORKERS_AI_EDGE_MODEL ?? "(default)"}  err=${err}`);
  console.log(`acc=${((tp + tn) / n * 100).toFixed(1)}% (${tp + tn}/${n})  vs cloud 98.5%`);
  console.log(`escalate recall=${tp}/${tp + fn}  precision=${tp}/${tp + fp || 0}`);
  console.log(`latency p50=${lat[Math.floor(lat.length / 2)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms  total=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("\n-- FN(取りこぼし escalate) --"); fns.forEach((it) => console.log(`  ${it.id} :: ${it.query.slice(0, 50)}`));
  console.log("-- FP(余分 escalate) --"); fps.forEach((it) => console.log(`  ${it.id} :: ${it.query.slice(0, 50)}`));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
