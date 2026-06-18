import { loadEnv } from "@/lib/load-env";
loadEnv();

import { serve } from "@hono/node-server";
import { createApp } from "@/app";
import { nodeDb } from "@/db/node";
import { drizzleRoutingLogger } from "@/lib/routing-observability";

// ローカル開発エントリ（Node ランタイム）。
// docker Postgres に node-postgres(TCP) で接続する。env は process.env から取得。
const connectionString = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!connectionString || !jwtSecret) {
  throw new Error("DATABASE_URL と JWT_SECRET が必要です（.env を読み込んだか確認）");
}

const db = nodeDb(connectionString);
const routingLogger = drizzleRoutingLogger(db);
const app = createApp({
  getDb: () => db,
  getJwtSecret: () => jwtSecret,
  getRoutingLogger: () => routingLogger,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`functest-hono listening on http://localhost:${info.port}`);
});
