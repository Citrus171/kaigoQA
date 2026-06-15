import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull().default("user"), // "user" | "admin"
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const todos = pgTable(
  "todos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("todos_user_id_idx").on(t.userId)],
);

export const schema = { users, todos };

// route 側は Postgres 共通のクエリ API しか使わないため、型は node 版に統一する
// （neon-http 版は同じ PgDatabase API を持つのでこの型へキャストして渡す）。
// type-only import なので Workers バンドルに pg は含まれない。
export type DB = import("drizzle-orm/node-postgres").NodePgDatabase<
  typeof schema
>;
