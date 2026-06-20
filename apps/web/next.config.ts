import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // TS のままのワークスペースパッケージをトランスパイルする。
  transpilePackages: ["@hybrid/shared", "@hybrid/api"],
  // k8s/コンテナ向け: 最小実行物 (.next/standalone) を出力。
  output: "standalone",
  // モノレポ: ワークスペース依存(@hybrid/*)を standalone に含めるためトレース基点を repo root に。
  // Next の config は CJS コンテキストで評価されるため __dirname がそのまま使える
  // （import.meta を使うと compiled.js が ESM/CJS 衝突で壊れる）。
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
