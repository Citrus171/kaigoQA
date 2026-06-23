import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // ブラウザ専用 API（SpeechRecognition 等）は純粋関数／ドライバー注入に隔離して
    // テストするため、jsdom は不要。node 環境で実行する。
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
