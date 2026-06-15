import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { and, desc, eq } from "drizzle-orm";
import { todos } from "@/db/schema";
import { createTodoSchema, setDoneSchema } from "@/lib/schemas";
import { authMiddleware } from "@/auth/middleware";
import { dispatchTodoCreated } from "@/jobs";
import type { AppEnv } from "@/types";

// hc 型推論のためチェーンで定義。全ルート要認証。
export const todoRoutes = new Hono<AppEnv>()
  .use("*", authMiddleware)
  // 自分の Todo 一覧。
  .get("/", async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const rows = await db
      .select()
      .from(todos)
      .where(eq(todos.userId, actor.id))
      .orderBy(desc(todos.createdAt));
    return c.json(rows);
  })
  // 作成。ジョブ投入。
  .post("/", zValidator("json", createTodoSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const { title } = c.req.valid("json");
    const [todo] = await db
      .insert(todos)
      .values({ title, userId: actor.id })
      .returning();
    await dispatchTodoCreated(todo!);
    return c.json(todo, 201);
  })
  // 完了切替（所有チェックを WHERE 句で = Phase1 DbAuthorizer）。
  .patch("/:id", zValidator("json", setDoneSchema), async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const id = c.req.param("id");
    const { done } = c.req.valid("json");
    const [updated] = await db
      .update(todos)
      .set({ done })
      .where(and(eq(todos.id, id), eq(todos.userId, actor.id)))
      .returning();
    if (!updated) throw new HTTPException(404, { message: "見つかりません" });
    return c.json(updated);
  })
  // object-level 認可版（所有者 or admin）。Authorizer 経由。
  .patch("/:id/set-done", zValidator("json", setDoneSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const { done } = c.req.valid("json");
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, id))
      .limit(1);
    if (!todo) throw new HTTPException(404, { message: "見つかりません" });
    c.get("authz").requireOwned(todo.userId);
    const [updated] = await db
      .update(todos)
      .set({ done })
      .where(eq(todos.id, id))
      .returning();
    return c.json(updated);
  })
  // 削除（所有チェックを WHERE 句で）。
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const actor = c.get("actor");
    const id = c.req.param("id");
    const [deleted] = await db
      .delete(todos)
      .where(and(eq(todos.id, id), eq(todos.userId, actor.id)))
      .returning();
    if (!deleted) throw new HTTPException(404, { message: "見つかりません" });
    return c.json({ ok: true });
  });
