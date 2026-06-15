import { createApp } from "@/app";
import { nodeDb, endDb } from "@/db/node";
import { users, todos } from "@/db/schema";
import { hashPassword } from "@/lib/password";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://app:app@localhost:5435/functest_hono_test?schema=public";

export const testDb = nodeDb(url);
export const JWT_SECRET = "test-secret";

// 本物のルート定義 + 本物の Drizzle + 本物の Postgres を app.request() 経由で叩く。
export const app = createApp({
  getDb: () => testDb,
  getJwtSecret: () => JWT_SECRET,
});

export async function resetDb(): Promise<void> {
  await testDb.delete(todos);
  await testDb.delete(users);
}

export async function closeDb(): Promise<void> {
  await endDb();
}

export async function createUser(
  email: string,
  role: "user" | "admin" = "user",
) {
  const [user] = await testDb
    .insert(users)
    .values({
      email,
      name: email,
      role,
      passwordHash: await hashPassword("password"),
    })
    .returning();
  return user!;
}

/** ログインして JWT を得る。 */
export async function login(email: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password" }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}
