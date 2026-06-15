import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // TS のままのワークスペースパッケージをトランスパイルする。
  transpilePackages: ["@hybrid/shared", "@hybrid/api"],
};

export default nextConfig;
