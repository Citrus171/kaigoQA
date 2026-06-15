import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import type { DB } from "@/db/schema";
import { authRoutes } from "@/routes/auth";
import { todoRoutes } from "@/routes/todos";
import { adminRoutes } from "@/routes/admin";

/**
 * db と jwtSecret の解決方法を注入してアプリを組み立てる。
 * - Workers: c.env(バインディング)から解決（neon-http）
 * - Node/テスト: process.env / 固定値から解決（node-postgres）
 * これにより同一のルート定義を両ランタイムで共有する。
 */
export type Resolvers = {
  getDb: (c: Context<AppEnv>) => DB;
  getJwtSecret: (c: Context<AppEnv>) => string;
};

export function createApp(resolvers: Resolvers) {
  // hc 型推論のためチェーンで組み立て、ルート型を蓄積したまま返す。
  const app = new Hono<AppEnv>()
    // 全リクエストで db / jwtSecret を context に載せる。
    .use("*", async (c, next) => {
      c.set("db", resolvers.getDb(c));
      c.set("jwtSecret", resolvers.getJwtSecret(c));
      await next();
    })
    // readiness/liveness。DB 疎通まで確認。
    .get("/health", async (c) => {
      try {
        await c.get("db").execute(sql`select 1`);
        return c.json({ status: "ok", db: "up" });
      } catch {
        return c.json({ status: "error", db: "down" }, 503);
      }
    })
    .route("/auth", authRoutes)
    .route("/todos", todoRoutes)
    .route("/admin", adminRoutes);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ message: "internal server error" }, 500);
  });

  return app;
}
