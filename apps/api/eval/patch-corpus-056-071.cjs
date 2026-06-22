// A0(a) 続き: gold-A-056/071 修正後の corpus.json + rag_chunks 一括更新
// 実行: node --env-file=.env apps/api/eval/patch-corpus-056-071.cjs
const fs = require("fs");
const { Client } = require("pg");

function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

async function embedText(text) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [text] }),
  });
  if (!res.ok) throw new Error(`CF embed failed: ${res.status}`);
  const json = await res.json();
  if (!json?.result?.data?.[0]) throw new Error("CF embed response missing data[0]");
  return l2normalize(json.result.data[0]);
}

(async () => {
  // 1. load gold, compute new texts
  const gold = fs
    .readFileSync("eval/data/routing-gold-a.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const g056 = gold.find((g) => g.id === "gold-A-056");
  const g071 = gold.find((g) => g.id === "gold-A-071");
  const newText056 = (g056.referencePoints || []).join("\n");
  const newText071 = (g071.referencePoints || []).join("\n");
  console.log("new A-056 text:", newText056.substring(0, 120));
  console.log("new A-071 text:", newText071.substring(0, 120));

  // 2. load corpus.json, update texts
  const CORPUS_PATH = "models/rag/corpus.json";
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
  let updated = 0;
  for (const c of corpus.chunks) {
    if (c.srcId === "gold-A-056") {
      c.text = newText056;
      updated++;
    }
    if (c.srcId === "gold-A-071") {
      c.text = newText071;
      updated++;
    }
  }
  console.log("corpus chunks updated:", updated);

  // 3. re-embed
  console.log("embedding gold-A-056...");
  const vec056 = await embedText(newText056);
  console.log(`  dim=${vec056.length} [${vec056.slice(0, 3).map((n) => n.toFixed(4)).join(",")}...]`);
  console.log("embedding gold-A-071...");
  const vec071 = await embedText(newText071);
  console.log(`  dim=${vec071.length} [${vec071.slice(0, 3).map((n) => n.toFixed(4)).join(",")}...]`);

  // 4. update vectors in corpus.json
  for (const c of corpus.chunks) {
    if (c.srcId === "gold-A-056") c.vector = vec056;
    if (c.srcId === "gold-A-071") c.vector = vec071;
  }
  corpus.builtAt = new Date().toISOString();
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus));
  console.log("corpus.json written");

  // 5. update DB
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(
    "UPDATE rag_chunks SET text=$1, vector=$2::vector WHERE src_id=$3",
    [newText056, `[${vec056.join(",")}]`, "gold-A-056"],
  );
  await client.query(
    "UPDATE rag_chunks SET text=$1, vector=$2::vector WHERE src_id=$3",
    [newText071, `[${vec071.join(",")}]`, "gold-A-071"],
  );

  // verify self-score
  const { rows } = await client.query(
    "SELECT src_id, 1 - (vector <=> $1::vector) AS self_score FROM rag_chunks WHERE src_id IN ($2,$3)",
    [`[${vec056.join(",")}]`, "gold-A-056", "gold-A-071"],
  );
  console.log("DB verify:", JSON.stringify(rows));

  await client.end();
  console.log("DB updated: 2 rows in rag_chunks");
  console.log("DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
