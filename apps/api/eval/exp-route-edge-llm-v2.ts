// (A) edge classify プロンプト調整版。負例few-shot追加でFP削減を狙う。test135と非重複。
import { loadEnv } from "../src/lib/load-env";
loadEnv();
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkersAiProvider } from "../src/lib/inference";
const HERE = dirname(fileURLToPath(import.meta.url));
type Item = { id: string; query: string; route_gold: "escalate" | "knowledge_qa" };

const PROMPT_V2 = `あなたは介護保険QAアシスタントのルーターです。利用者の質問を次の2つに分類してください。

- "escalate": 利用者**個人の具体的なケース**について、金額・自己負担額・利用回数・単位数などの**数値的な結果**を求めており、その答えが地域区分・事業所規模・サービス時間区分・負担割合・本人の所得など、質問文に与えられていない変数に依存して**一意に確定できない**もの。
- "knowledge_qa": 制度・要件・手続き・適格性の説明、サービスの紹介、一般的な費用・上限額・算定基準・規則の説明、「どのように計算されるか（一般的な手順）」など、**参考知識で答えられる**もの。金額や回数の語を含んでいても、特定個人のケースの計算でなければ knowledge_qa。

例:
Q「母は要介護2です。デイサービスを週3回使うと毎月いくら払いますか」→ escalate
Q「年金収入が180万円の単身世帯なら自己負担は何割になりますか」→ escalate
Q「介護保険の自己負担割合はどのように決まりますか」→ knowledge_qa
Q「福祉用具貸与を利用するにはどんな手続きが必要ですか」→ knowledge_qa
Q「特別養護老人ホームの費用と入居条件を教えてください」→ knowledge_qa
Q「福祉用具購入費の支給限度額はいくらですか」→ knowledge_qa
Q「サービスを休んだ月でも利用料は発生しますか」→ knowledge_qa
Q「近くで入居できる施設を探しています」→ knowledge_qa

質問: {query}

次のJSONのみを返答（前置き・コードフェンス不要）:
{"route": "escalate"|"knowledge_qa", "reason": "20字以内の判定理由"}`;

function parse(text: string): "escalate" | "knowledge_qa" {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return "knowledge_qa";
  try { const o = JSON.parse(m[0]); return o.route === "escalate" ? "escalate" : "knowledge_qa"; }
  catch { return "knowledge_qa"; }
}
async function mapLimit<T, R>(arr: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < arr.length) { const i = idx++; out[i] = await fn(arr[i]!); } }));
  return out;
}
async function main() {
  const raw = await readFile(join(HERE, "data", "rag-router-log.jsonl"), "utf8");
  const items: Item[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  const edge = new WorkersAiProvider();
  const preds = await mapLimit(items, 4, async (it) => {
    try { const { text } = await edge.infer(PROMPT_V2.replace("{query}", it.query)); return parse(text); }
    catch { return "ERROR" as any; }
  });
  let tp = 0, fp = 0, fn = 0, tn = 0, err = 0; const fns: Item[] = [], fps: Item[] = [];
  items.forEach((it, i) => {
    const p = preds[i]; if (p === "ERROR") { err++; return; }
    if (it.route_gold === "escalate") p === "escalate" ? tp++ : (fn++, fns.push(it));
    else p === "escalate" ? (fp++, fps.push(it)) : tn++;
  });
  const n = items.length - err;
  console.log("=== (A) edge(Gemma) classifyRoute PROMPT V2 ===");
  console.log(`acc=${((tp + tn) / n * 100).toFixed(1)}% (${tp + tn}/${n})  err=${err}  vs cloud 98.5% / edge-v1 94.8%`);
  console.log(`escalate recall=${tp}/${tp + fn}  precision=${tp}/${tp + fp || 0}`);
  console.log("-- FN(取りこぼし) --"); fns.forEach((it) => console.log(`  ${it.id} :: ${it.query.slice(0, 50)}`));
  console.log("-- FP(余分) --"); fps.forEach((it) => console.log(`  ${it.id} :: ${it.query.slice(0, 50)}`));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
