import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema, type DB } from "./schema";

// ローカル/テスト用。docker Postgres に TCP 接続する。
// Pool は使い回す（Node プロセス内でキャッシュ）。
let cachedPool: pg.Pool | undefined;
let cached: DB | undefined;

export function nodeDb(connectionString: string): DB {
  if (!cached) {
    cachedPool = new pg.Pool({ connectionString });
    cached = drizzle(cachedPool, { schema });
  }
  return cached;
}

/** テスト終了時に Pool を閉じる（ハンドルリーク防止）。 */
export async function endDb(): Promise<void> {
  await cachedPool?.end();
  cachedPool = undefined;
  cached = undefined;
}
