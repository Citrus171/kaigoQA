import { defineConfig, devices } from "@playwright/test";

// k3d 実機 E2E 用設定。
// web サーバーは kubectl port-forward svc/web 3456:3000 で既に露出済み前提。
// api も port-forward svc/api 8787:8787 で露出済み（BFF プロキシが転送）。
// webServer.command は空 = 外部起動を reuse する。url で到達確認のみ。
//
// 実行:
//   kubectl port-forward -n kaigo svc/api 8787:8787 &
//   K3D_WEB_PORT=3456 kubectl port-forward -n kaigo svc/web 3456:3000 &
//   （K3D_WEB_PORT 省略時は 3456 既定。3000 が別コンテナに占有されている場合は変更）
//   npx playwright test --config=apps/web/playwright.k3d.config.ts
const WEB_PORT = process.env.K3D_WEB_PORT ?? "3456";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /chat-k3d\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // port-forward は手動で起動済み前提。起動チェックのみ。
    command: `echo k3d port-forward must be running on :${WEB_PORT}`,
    url: `http://localhost:${WEB_PORT}/login`,
    timeout: 10_000,
    reuseExistingServer: true,
  },
});
