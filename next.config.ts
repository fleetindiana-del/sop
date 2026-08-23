import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  // Keep native canvas binaries and pdfjs worker files in serverless traces.
  // pdfjs-dist loads pdf.worker.mjs via a dynamic import that NFT does not follow.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-musl/**/*",
      "./node_modules/@napi-rs/canvas-linux-arm64-gnu/**/*",
      "./node_modules/@napi-rs/canvas-linux-arm64-musl/**/*",
      "./node_modules/@napi-rs/canvas-win32-x64-msvc/**/*",
      "./node_modules/pdf-parse/dist/worker/**/*",
    ],
  },
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
    proxyClientMaxBodySize: "50mb",
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
