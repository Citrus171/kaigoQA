import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { schema, type DB } from "./schema";

// Workers/本番用。Neon serverless ドライバ(HTTP)。リクエストごとに生成して良い（ステートレス）。
export function neonDb(connectionString: string): DB {
  return drizzle(neon(connectionString), { schema }) as unknown as DB;
}
