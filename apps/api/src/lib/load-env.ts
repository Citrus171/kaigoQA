import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 依存なしの簡易 .env ローダ（ローカル開発/シード/drizzle-kit 用）。
// 既存の process.env を上書きしない（CI の実 env を優先）。
export function loadEnv(file = ".env"): void {
  try {
    const text = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      if (process.env[key] !== undefined) continue;
      let val = m[2]!;
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // .env が無ければ何もしない
  }
}
