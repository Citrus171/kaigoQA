import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { sign } from "hono/jwt";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { loginSchema } from "@/lib/schemas";
import { verifyPassword } from "@/lib/password";
import type { AppEnv } from "@/types";

// hc の型推論のためチェーンで定義する（ルートが型に蓄積される）。
export const authRoutes = new Hono<AppEnv>().post(
  "/login",
  zValidator("json", loginSchema),
  async (c) => {
    const { email, password } = c.req.valid("json");
    const db = c.get("db");

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HTTPException(401, {
        message: "メールアドレスまたはパスワードが違います",
      });
    }

    const token = await sign(
      {
        sub: user.id,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24h
      },
      c.get("jwtSecret"),
    );

    return c.json({ token });
  },
);
