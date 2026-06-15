import { Hono } from "hono";
import { count, eq } from "drizzle-orm";
import { todos, users } from "@/db/schema";
import { authMiddleware, adminMiddleware } from "@/auth/middleware";
import type { AppEnv } from "@/types";

// 要認証 + admin role。hc 型推論のためチェーンで定義。
export const adminRoutes = new Hono<AppEnv>()
  .use("*", authMiddleware, adminMiddleware)
  // 全ユーザー横断の集計（所有の枠を超えるため admin 限定）。
  .get("/stats", async (c) => {
    const db = c.get("db");
    const [u] = await db.select({ value: count() }).from(users);
    const [t] = await db.select({ value: count() }).from(todos);
    const [d] = await db
      .select({ value: count() })
      .from(todos)
      .where(eq(todos.done, true));
    return c.json({
      users: u?.value ?? 0,
      todos: t?.value ?? 0,
      done: d?.value ?? 0,
    });
  });
