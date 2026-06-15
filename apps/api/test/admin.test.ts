import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  app,
  resetDb,
  closeDb,
  createUser,
  login,
  bearer,
} from "./helpers";

describe("admin の RBAC 境界", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("一般ユーザーは /admin/stats を呼べない（403）", async () => {
    await createUser("user@example.com", "user");
    const token = await login("user@example.com");
    const res = await app.request("/admin/stats", { headers: bearer(token) });
    expect(res.status).toBe(403);
  });

  it("admin は横断集計を取得できる", async () => {
    await createUser("admin@example.com", "admin");
    await createUser("alice@example.com", "user");
    const adminToken = await login("admin@example.com");
    const aToken = await login("alice@example.com");

    await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "a-1" }),
    });
    await app.request("/todos", {
      method: "POST",
      headers: bearer(adminToken),
      body: JSON.stringify({ title: "admin-1" }),
    });

    const res = await app.request("/admin/stats", {
      headers: bearer(adminToken),
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      users: number;
      todos: number;
      done: number;
    };
    expect(stats.users).toBe(2);
    expect(stats.todos).toBe(2);
    expect(stats.done).toBe(0);
  });

  it("admin は他人の Todo も set-done できる（Authorizer: admin 全許可）", async () => {
    await createUser("admin@example.com", "admin");
    await createUser("alice@example.com", "user");
    const adminToken = await login("admin@example.com");
    const aToken = await login("alice@example.com");
    const created = await app.request("/todos", {
      method: "POST",
      headers: bearer(aToken),
      body: JSON.stringify({ title: "alice" }),
    });
    const todo = (await created.json()) as { id: string };

    const res = await app.request(`/todos/${todo.id}/set-done`, {
      method: "PATCH",
      headers: bearer(adminToken),
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { done: boolean };
    expect(updated.done).toBe(true);
  });
});
