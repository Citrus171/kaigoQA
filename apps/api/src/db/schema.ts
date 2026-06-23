import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  real,
  integer,
  vector,
  jsonb,
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

// Router Observability（MLOps）: /ai/qa の判定・検索・推論メタを記録する。
//   メタ（score/margin/sim/versions/latency）のみ＝PII非保持。query_ref は hash 先端のみ。
//   rule 経路（埋め込み不通フォールバック）では score/threshold/margin/sim は null。
//   RAG 検索結果は srcId のみ（本文は rag_chunks と結合で復元・PIIなし）。
//   エラー時は served/versions 等は埋まらないが errorCode が入り、障害再現に使う。
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    reqId: text("req_id").notNull(),
    ts: timestamp("ts").notNull().defaultNow(),
    queryRef: text("query_ref").notNull(), // sha256 先端のみ（全文は保持しない）
    // 段1 Capability Router（ドメイン内での knowledge_qa/escalate 分岐）。
    //   ドメイン外(general)やエラー時は null。現在は LLM few-shot 分類（method=llm）。
    //   score/threshold/margin/sim は埋め込み分類器導入時用の予備（現状 null）。
    method: text("method"), // "llm" | "classifier" | "rule"（未実行時 null）
    route: text("route"), // "knowledge_qa" | "escalate" | "general"（段1/段0 の最終 route）
    routeReason: text("route_reason"),
    score: real("score"),
    threshold: real("threshold"),
    margin: real("margin"),
    simCloud: real("sim_cloud"),
    simEdge: real("sim_edge"),
    // 段2 cascade（edge 自信不足/ガードレールで cloud へ巻き戻し）。
    edgeConfidence: real("edge_confidence"),
    escalated: boolean("escalated"),
    guardrailEsc: boolean("guardrail_esc"),
    served: text("served"), // "edge" | "cloud"（エラー時 null）
    // RAG 検索（pgvector retrieval）。ドメイン判定の根拠 + 参照知識の監査。
    topScore: real("top_score"), // retrieval top-1 cosine
    domain: text("domain"), // "in" | "out"（topScore >= RAG_DOMAIN_THRESHOLD で in）
    // jsonb 配列。集計（jsonb_array_elements で展開し avg/min/max）を素直に書けるようにする。
    retrievedSrcIds: jsonb("retrieved_src_ids").$type<string[]>(), // ["gold-A-037",...]（srcId のみ）
    retrievedScores: jsonb("retrieved_scores").$type<number[]>(), // [0.758,0.705,...]
    // 出力・エラー。answerRef は回答本文の sha256 先端（本文は保持しない）。
    answerRef: text("answer_ref"),
    errorCode: text("error_code"), // 429/502/timeout/connrefused/empty 等（成功時 null）
    // versions/latency は既存。エラー時は latency が embed 途中で止まりうる。
    embedModel: text("embed_model"),
    classifierVersion: text("classifier_version"),
    genModel: text("gen_model"),
    latencyEmbed: integer("latency_embed"),
    latencyGen: integer("latency_gen"),
    latencyTotal: integer("latency_total").notNull(),
  },
  (t) => [
    index("routing_margin_idx").on(t.margin),
    index("routing_served_idx").on(t.served),
    index("routing_ts_idx").on(t.ts),
    index("routing_domain_idx").on(t.domain),
    index("routing_error_idx").on(t.errorCode),
    index("routing_route_idx").on(t.route),
  ],
);

// RAG コーパスチャンク（pgvector）。build:rag の成果物を DB に永続化し、
// retrieveTopK を JS 全件 cosine から pgvector <=> 演算に差し替える。
//   - vector: bge-m3 1024次元・L2 正規化済み（cosine distance は正規化ベクトルで精度保証）。
//   - srcId: corpus.json の gold-A-xxx 等。
export const ragChunks = pgTable("rag_chunks", {
  srcId: text("src_id").primaryKey(),
  text: text("text").notNull(),
  vector: vector("vector", { dimensions: 1024 }).notNull(),
  // citation + date鮮度用メタ。ingest 元(mhlw-qa-chunks.jsonl)にフル装備だが、
  // gold-A 135件(corpus.json)はメタなし → 全列 nullable で混在対応。
  //   - heading: 項目見出し（citation の主軸）
  //   - date: 事務連絡タイトル（発出時期含む長文）。文字列のまま、②で和暦日付を抽出
  //   - source: 出典文書名（mhlw は "介護サービス関係Q&A集" 固定）
  //   - page: PDF ページ番号
  heading: text("heading"),
  date: text("date"),
  source: text("source"),
  page: integer("page"),
});

export const schema = { users, todos, routingDecisions, ragChunks };

// route 側は Postgres 共通のクエリ API しか使わないため、型は node 版に統一する
// （neon-http 版は同じ PgDatabase API を持つのでこの型へキャストして渡す）。
// type-only import なので Workers バンドルに pg は含まれない。
export type DB = import("drizzle-orm/node-postgres").NodePgDatabase<
  typeof schema
>;
