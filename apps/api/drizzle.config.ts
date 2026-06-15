import { defineConfig } from "drizzle-kit";
import { loadEnv } from "./src/lib/load-env";

loadEnv();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://app:app@localhost:5435/functest_hono?schema=public",
  },
});
