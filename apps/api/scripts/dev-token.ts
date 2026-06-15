// dev用: JWT_SECRET で署名したアクセストークンを1個発行して標準出力に出す。
// /ai/ask など認証必須エンドポイントを DB/ログインなしで手軽に試すための補助。
// 用途は dev のみ（本番のトークンはログインフローで発行される）。
//
// 実行: npm run token -w @hybrid/api            # demo(user) ロール
//       npm run token -w @hybrid/api -- admin   # admin ロール

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { sign } from "hono/jwt";

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("JWT_SECRET が未設定です（.env を確認）");
  process.exit(1);
}

const role = process.argv[2] === "admin" ? "admin" : "user";
const payload = {
  sub: role === "admin" ? "dev-admin" : "dev-user",
  role,
  exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1時間有効
};

const token = await sign(payload, secret, "HS256");
process.stdout.write(token);
