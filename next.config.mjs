/** @type {import('next').NextConfig} */
const serverExternalPackages = [
  "better-sqlite3",
  "discord.js",
  "grammy",
  "@whiskeysockets/baileys",
  "@slack/web-api",
  "@slack/socket-mode",
  "@xenova/transformers",
  "onnxruntime-node",
  "sqlite-vec",
  "sqlite-vec-linux-x64",
  "sqlite-vec-linux-arm64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-win32-x64-msvc",
  "sqlite-vec-win32-arm64-msvc",
];

const standaloneBuild = process.env.DISP8CH_STANDALONE_BUILD === "1";

const nextConfig = {
  // `next start` does not work with output:"standalone" (it warns and can serve a
  // stale/incomplete build). Default to a normal build so `pnpm start` is correct;
  // desktop packaging can opt into standalone with DISP8CH_STANDALONE_BUILD=1.
  output: standaloneBuild ? "standalone" : undefined,
  outputFileTracing: standaloneBuild,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: serverExternalPackages,
    outputFileTracingExcludes: {
      "**/*": [
        "data/**",
        "logs/**",
        "dist/**",
        ".desktop-runtime/**",
        "docs/improvements/**",
      ],
    },
  },
  webpack: (config, { isServer }) => {
    config.externals = [...(config.externals || []), ...serverExternalPackages];
    // In the client bundle, tell webpack to ignore fs/path — the logger guards
    // these calls with typeof window checks so they never run in the browser.
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
    }
    return config;
  },
};

export default nextConfig;
