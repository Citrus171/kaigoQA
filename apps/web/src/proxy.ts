import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 認証ガード（案Y 補完）。web は DB/JWT_SECRET を持たないため cookie 有無のみで判定し、
// 実効性は api 側 401 に委ねる（多層防御）。クライアント側 401→/login はフォールバックとして残置。
const SESSION_COOKIE = "session";

export function proxy(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSession) {
    const login = new URL("/login", req.url);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

// 保護対象は /chat, /todos のみ。/login, /api/*, /_next/* は素通し。
export const config = {
  matcher: ["/chat", "/todos"],
};
