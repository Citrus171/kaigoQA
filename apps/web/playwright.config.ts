import { defineConfig, devices } from "@playwright/test";

// /chat の E2E。api は page.route でモックするため web サーバー単独で完結する。
// PORT=3456 で next dev を起動（CLAUDE.md の推奨起動法に合わせる）。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3456",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "PORT=3456 npm run dev",
    url: "http://localhost:3456/login",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // api はモックするため到達しないが、BFF が未設定で落ちないようダミーを入れる。
      API_ORIGIN: "http://localhost:9999",
    },
  },
});
