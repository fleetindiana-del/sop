import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // Keep SOP binary trees out of serverless NFT traces (they are runtime disk/CDN assets).
  outputFileTracingExcludes: {
    "*": [
      "./files/**/*",
      "./temp/**/*",
      "./guidelines-download/**/*",
      "./excel/**/*",
      "./.claude/**/*",
      "./memory/**/*",
      "./scripts/**/*",
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
    // Fewer workers during static generation — this repo has large on-disk SOP trees.
    cpus: 4,
  },
  // Keep more dev pages compiled in memory so visiting a new route doesn't
  // evict/recompile shared chunks (e.g. root layout) and force-reload other open tabs.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
};

export default nextConfig;
