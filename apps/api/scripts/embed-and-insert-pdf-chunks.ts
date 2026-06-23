// PDF chunks の embedding + DB投入（k3d postgres 向け）。
//
// mhlw-qa-chunks.jsonl の1954件を CF bge-m3 で embedding し、
// k3d postgres の rag_chunks テーブルへ追加挿入（既存135件は保持）。
//
// 前提: kubectl port-forward svc/postgres 5436:5432 が稼働中
//        apps/api/.env に CF_ACCOUNT_ID / CF_API_TOKEN がある
//
// 実行: npx tsx scripts/embed-and-insert-pdf-chunks.ts

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNKS_PATH = join(HERE, "..", "eval", "data", "pdf", "mhlw-qa-chunks.jsonl");

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CF_API_TOKEN!;
const EMBED_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`;
const DB_URL = "postgresql://app:app@localhost:5436/functest_hono";

const BATCH_SIZE = 50;

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`CF embed failed: ${res.status} ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { result?: { data?: number[][] } };
  const data = json.result?.data;
  if (!data || data.length !== texts.length) throw new Error("CF embed response mismatch");
  return data;
}

async function main() {
  const txt = await readFile(CHUNKS_PATH, "utf8");
  const chunks = txt.trim().split("\n").map((l) => JSON.parse(l) as {
    srcId: string; text: string; heading?: string; question?: string;
    date?: string; source?: string; page?: number;
  });
  console.log(`chunks to embed: ${chunks.length}`);

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // 既存チャンク確認（重複挿入を防ぐ）
  const { rows: existing } = await client.query("SELECT src_id FROM rag_chunks WHERE src_id LIKE 'mhlw-qa-%'");
  const existingIds = new Set(existing.map((r) => r.src_id));
  const toInsert = chunks.filter((c) => !existingIds.has(c.srcId));
  console.log(`existing mhlw chunks in DB: ${existingIds.size}, to insert: ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("nothing to insert — all chunks already in DB");
    await client.end();
    return;
  }

  // バッチ embedding
  const embedded: {
    srcId: string; text: string; vector: number[];
    heading?: string; date?: string; source?: string; page?: number;
  }[] = [];
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE)!;
    const texts = batch.map((c) => c.text);
    try {
      const vecs = await embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        embedded.push({
          srcId: batch[j]!.srcId,
          text: batch[j]!.text,
          vector: l2normalize(vecs[j]!),
          heading: batch[j]!.heading,
          date: batch[j]!.date,
          source: batch[j]!.source,
          page: batch[j]!.page,
        });
      }
    } catch (e) {
      console.warn(`\n  [warn] batch ${i / BATCH_SIZE + 1} failed: ${(e as Error).message}`);
      // 個別embeddingでフォールバック
      for (const c of batch) {
        try {
          const [v] = await embedBatch([c.text]);
          embedded.push({
            srcId: c.srcId, text: c.text, vector: l2normalize(v!),
            heading: c.heading, date: c.date, source: c.source, page: c.page,
          });
        } catch (e2) {
          console.warn(`  [skip] ${c.srcId}: ${(e2 as Error).message}`);
        }
      }
    }
    process.stdout.write(`\r  embedded ${Math.min(i + BATCH_SIZE, toInsert.length)}/${toInsert.length}`);
    if (i + BATCH_SIZE < toInsert.length) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`\nembedded: ${embedded.length}/${toInsert.length}`);

  // DBへ一括挿入（500件ずつ）。heading/date/source/page も格納（citation 用メタ）。
  for (let i = 0; i < embedded.length; i += 500) {
    const batch = embedded.slice(i, i + 500)!;
    const values = batch.map((_, j) =>
      `($${j * 7 + 1}, $${j * 7 + 2}, $${j * 7 + 3}::vector, $${j * 7 + 4}, $${j * 7 + 5}, $${j * 7 + 6}, $${j * 7 + 7})`
    ).join(", ");
    const params: (string | number | null)[] = [];
    for (const c of batch) {
      params.push(
        c.srcId, c.text, `[${c.vector.join(",")}]`,
        c.heading ?? null, c.date ?? null, c.source ?? null, c.page ?? null,
      );
    }
    await client.query(
      `INSERT INTO rag_chunks (src_id, text, vector, heading, date, source, page) VALUES ${values} ON CONFLICT (src_id) DO NOTHING`,
      params,
    );
    process.stdout.write(`\r  inserted ${Math.min(i + 500, embedded.length)}/${embedded.length}`);
  }
  console.log();

  // 確認
  const { rows: count } = await client.query("SELECT count(*) FROM rag_chunks");
  console.log(`\nrag_chunks total: ${count[0].count}`);

  // ターゲットチャンクの検索確認
  const { rows: target } = await client.query(
    `SELECT src_id, 1 - (vector <=> (SELECT vector FROM rag_chunks WHERE src_id = 'mhlw-qa-0001-1')) AS score
     FROM rag_chunks WHERE src_id = 'mhlw-qa-0001-1'`,
  );
  if (target.length > 0) {
    console.log(`target self-score: ${target[0].score.toFixed(4)}`);
  }

  await client.end();
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
