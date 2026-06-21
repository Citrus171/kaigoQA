// ドメイン足切り閾値 θ の実測（エンドポイント統合の段1で使う）。
// 介護保険ドメイン内/外のサンプル質問の top-1 retrieval score を出し、両者を分離する θ を選ぶ。
// 実行: npm run measure:threshold -w @hybrid/api（CF bge-m3 を叩くので CF_* env が要る）。
import { loadEnv } from "@/lib/load-env";
import { retrieveTopK } from "@/lib/rag";
import { nodeDb, endDb } from "@/db/node";

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");
const db = nodeDb(url);

const inDomain = [
  "介護保険の自己負担割合はどのように決まりますか",
  "要介護認定の更新手続きはどうすればいいですか",
  "福祉用具貸与を利用するにはどんな手続きが必要ですか",
  "区分支給限度基準額とは何ですか",
  "訪問介護のサービス内容を教えてください",
];
const outDomain = [
  "東京の明日の天気を教えて",
  "Pythonでforループを書く方法は？",
  "おすすめのイタリアンレストランはどこですか",
  "今日の日経平均株価はいくらですか",
  "富士山の標高は何メートルですか",
];

async function top1(q: string): Promise<number> {
  const [hit] = await retrieveTopK(db, q, 1);
  return hit?.score ?? 0;
}

async function main() {
  const inScores: number[] = [];
  const outScores: number[] = [];
  console.log("=== ドメイン内（介護保険） ===");
  for (const q of inDomain) {
    const s = await top1(q);
    inScores.push(s);
    console.log(`  ${s.toFixed(3)}  ${q}`);
  }
  console.log("=== ドメイン外（無関係） ===");
  for (const q of outDomain) {
    const s = await top1(q);
    outScores.push(s);
    console.log(`  ${s.toFixed(3)}  ${q}`);
  }
  const minIn = Math.min(...inScores);
  const maxOut = Math.max(...outScores);
  console.log(`\nドメイン内 最小 = ${minIn.toFixed(3)}`);
  console.log(`ドメイン外 最大 = ${maxOut.toFixed(3)}`);
  console.log(`分離ギャップ = ${(minIn - maxOut).toFixed(3)}`);
  console.log(`θ 候補（中点）= ${((minIn + maxOut) / 2).toFixed(3)}`);
  await endDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
