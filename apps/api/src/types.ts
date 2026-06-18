import type { DB } from "./db/schema";
import type { Actor, Authorizer } from "./authz";
import type { RoutingLogger } from "@/lib/routing-observability";

export type Bindings = {
  DATABASE_URL: string;
  JWT_SECRET: string;
  DB_DRIVER?: string;
};

export type Variables = {
  db: DB;
  jwtSecret: string;
  actor: Actor; // authMiddleware 通過後にセットされる
  authz: Authorizer;
  routingLogger: RoutingLogger; // createApp で注入（未指定=no-op）
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
