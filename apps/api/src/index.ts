import { createApp } from "@/app";
import { neonDb } from "@/db/neon";

// Cloudflare Workers エントリ。env はリクエストごとに c.env(バインディング)から取得する。
// Neon serverless ドライバ(HTTP)を使うため pg は import しない。
const app = createApp({
  getDb: (c) => neonDb(c.env.DATABASE_URL),
  getJwtSecret: (c) => c.env.JWT_SECRET,
});

export default app;

// web 側が hc<AppType> で型付きクライアントを得るためにエクスポート。
export type AppType = typeof app;
