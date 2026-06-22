// DB から BM25 用ドキュメントをロード（rag_chunks 全件）。
// drizzle の sql タグで取得し、BM25 インデックス構築に渡す。

import { sql } from "drizzle-orm";
import type { DB } from "@/db/schema";
import type { Bm25Doc } from "@/lib/bm25";

export async function loadBm25Docs(db: DB): Promise<Bm25Doc[]> {
  const result = await db.execute(
    sql`SELECT src_id AS "srcId", text FROM rag_chunks ORDER BY src_id`,
  );
  return result.rows.map((r) => ({
    srcId: String(r.srcId ?? ""),
    text: String(r.text ?? ""),
  }));
}
