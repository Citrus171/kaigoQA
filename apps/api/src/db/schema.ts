import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  real,
  integer,
} from "drizzle-orm/pg-core";

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

// Router Observability（MLOps）: 段1の振り分け判定を「理由つき」で記録する。
//   メタ（score/margin/sim/versions/latency）のみ＝PII非保持。query_ref は hash 先端のみ。
//   rule 経路（埋め込み不通フォールバック）では score/threshold/margin/sim は null。
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    reqId: text("req_id").notNull(),
    ts: timestamp("ts").notNull().defaultNow(),
    queryRef: text("query_ref").notNull(), // sha256 先端のみ（全文は保持しない）
    method: text("method").notNull(), // "classifier" | "rule"
    score: real("score"),
    threshold: real("threshold"),
    margin: real("margin"),
    simCloud: real("sim_cloud"),
    simEdge: real("sim_edge"),
    edgeConfidence: real("edge_confidence"),
    escalated: boolean("escalated"),
    guardrailEsc: boolean("guardrail_esc"),
    served: text("served").notNull(), // "edge" | "cloud"
    embedModel: text("embed_model").notNull(),
    classifierVersion: text("classifier_version").notNull(),
    genModel: text("gen_model").notNull(),
    latencyEmbed: integer("latency_embed"),
    latencyGen: integer("latency_gen"),
    latencyTotal: integer("latency_total").notNull(),
  },
  (t) => [
    index("routing_margin_idx").on(t.margin),
    index("routing_served_idx").on(t.served),
    index("routing_ts_idx").on(t.ts),
  ],
);

export const schema = { users, todos, routingDecisions };

// route 側は Postgres 共通のクエリ API しか使わないため、型は node 版に統一する
// （neon-http 版は同じ PgDatabase API を持つのでこの型へキャストして渡す）。
// type-only import なので Workers バンドルに pg は含まれない。
export type DB = import("drizzle-orm/node-postgres").NodePgDatabase<
  typeof schema
>;
