import { loadEnv } from "@/lib/load-env";
loadEnv();

import { nodeDb } from "@/db/node";
import { users, todos } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が必要です");

const db = nodeDb(url);

async function upsertUser(
  email: string,
  name: string,
  role: "user" | "admin",
) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email, name, role, passwordHash: await hashPassword("password") })
    .returning();
  return created!;
}

async function main() {
  const demo = await upsertUser("demo@example.com", "デモユーザー", "user");
  await upsertUser("admin@example.com", "管理者", "admin");

  const owned = await db.select().from(todos).where(eq(todos.userId, demo.id));
  if (owned.length === 0) {
    await db.insert(todos).values([
      { title: "Hono の動作を確認する", userId: demo.id },
      { title: "認可境界テストを確認する", userId: demo.id, done: true },
    ]);
  }

  console.log(
    "seeded: demo@example.com (user) / admin@example.com (admin) / password",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
