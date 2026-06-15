import { hc } from "hono/client";
import type { AppType } from "@hybrid/api";

// 同一オリジンの /api を叩く。Next の BFF プロキシ(app/api/[...path])が
// httpOnly cookie の JWT を Bearer に変換して Hono(API_ORIGIN) へ転送する。
export const api = hc<AppType>("/api");
