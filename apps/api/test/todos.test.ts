import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  app,
  testDb,
  resetDb,
  closeDb,
  createUser,
  login,
  bearer,
} from "./helpers";
import { todos } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("todos の認可境界", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("未認証は 401", async () => {
    const res = await app.request("/todos");
    expect(res.status).toBe(401);
  });

  it("作成した Todo は本人に紐づき 201", async () => {
    const alice = await createUser("alice@example.com");
    const token = await login("alice@example.com");
    const res = await app.request("/todos", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "買い物" }),
    });
    expect(res.status).toBe(201);
    const todo = (await res.json()) as { userId: string; title: string };
    expect(todo.userId).toBe(alice.id);
    expect(todo.title).toBe("買い物");
  });

  it("一覧は自分の Todo だけ返す", async () => {
    await createUser("alice@example.com");
    await createUser("bob@example.com");
    const aToken = await login("alice@example.com");
    const bToken = await login("bob@example.com");

    await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "a-1" }),
    });
    await app.request("/todos", {
      method: "POST",
      headers: bearer(bToken),
      body: JSON.stringify({ title: "b-1" }),
    });

    const res = await app.request("/todos", { headers: bearer(aToken) });
    const list = (await res.json()) as { title: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("a-1");
  });

  it("他人の Todo は完了切替できない（404・状態も不変）", async () => {
    const alice = await createUser("alice@example.com");
    await createUser("bob@example.com");
    const aToken = await login("alice@example.com");
    const bToken = await login("bob@example.com");

    const created = await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "alice秘密" }),
    });
    const todo = (await created.json()) as { id: string };

    const res = await app.request(`/todos/${todo.id}`, {
      method: "PATCH",
      headers: bearer(bToken),
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(404);

    const [reloaded] = await testDb
      .select()
      .from(todos)
      .where(eq(todos.id, todo.id));
    expect(reloaded!.done).toBe(false);
    expect(reloaded!.userId).toBe(alice.id);
  });

  it("他人の Todo は削除できない（404）", async () => {
    await createUser("alice@example.com");
    await createUser("bob@example.com");
    const aToken = await login("alice@example.com");
    const bToken = await login("bob@example.com");
    const created = await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "alice" }),
    });
    const todo = (await created.json()) as { id: string };

    const res = await app.request(`/todos/${todo.id}`, {
      method: "DELETE",
      headers: bearer(bToken),
    });
    expect(res.status).toBe(404);
    const rows = await testDb.select().from(todos).where(eq(todos.id, todo.id));
    expect(rows).toHaveLength(1);
  });

  it("set-done は他人（非admin）だと 403（Authorizer）", async () => {
    await createUser("alice@example.com");
    await createUser("bob@example.com");
    const aToken = await login("alice@example.com");
    const bToken = await login("bob@example.com");
    const created = await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "alice" }),
    });
    const todo = (await created.json()) as { id: string };

    const res = await app.request(`/todos/${todo.id}/set-done`, {
      method: "PATCH",
      headers: bearer(bToken),
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(403);
  });

  it("空タイトルは 400（zValidator）", async () => {
    await createUser("alice@example.com");
    const token = await login("alice@example.com");
    const res = await app.request("/todos", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });
});
