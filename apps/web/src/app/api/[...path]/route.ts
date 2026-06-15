import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:8787";
const COOKIE = "session";

// BFF プロキシ（案Y）。
// - cookie の JWT を Authorization: Bearer に変換して Hono へ転送
// - auth/login は特例：Hono の {token} を httpOnly cookie に格納し、token はクライアントに返さない
async function handler(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const subPath = path.join("/");
  const search = new URL(req.url).search;
  const target = `${API_ORIGIN}/${subPath}${search}`;

  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.text();

  const res = await fetch(target, { method: req.method, headers, body });

  // ログイン特例：トークンを cookie に隠す。
  if (subPath === "auth/login" && res.ok) {
    const data = (await res.json()) as { token: string };
    const out = NextResponse.json({ ok: true });
    out.cookies.set(COOKIE, data.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24,
    });
    return out;
  }

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as PUT,
  handler as DELETE,
};
