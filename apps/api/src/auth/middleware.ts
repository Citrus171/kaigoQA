import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import { RbacAuthorizer, toRole } from "@/authz";
import type { AppEnv } from "@/types";

/** Bearer トークンを検証し、actor / authz を context に載せる。 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) throw new HTTPException(401, { message: "認証が必要です" });

  let payload;
  try {
    payload = await verify(token, c.get("jwtSecret"), "HS256");
  } catch {
    throw new HTTPException(401, { message: "トークンが無効です" });
  }

  const actor = { id: String(payload.sub), role: toRole(payload.role) };
  c.set("actor", actor);
  c.set("authz", new RbacAuthorizer(actor));
  await next();
});

/** admin role を要求する。authMiddleware の後段で使う。 */
export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.get("authz").requireRole("admin");
  await next();
});
