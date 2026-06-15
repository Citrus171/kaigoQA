import { NextResponse } from "next/server";

// ログアウト（web 専用）。JWT はステートレスなので cookie 削除のみ。
// [...path] より具体的なルートなので優先してマッチする。
export async function POST(): Promise<Response> {
  const out = NextResponse.json({ ok: true });
  out.cookies.set("session", "", { path: "/", maxAge: 0 });
  return out;
}
