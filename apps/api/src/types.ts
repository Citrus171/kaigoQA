import type { DB } from "./db/schema";
import type { Actor, Authorizer } from "./authz";

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
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
