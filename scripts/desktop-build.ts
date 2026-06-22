import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const outDir = path.resolve(process.cwd(), ".desktop");
fs.mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node" as const,
  target: "node22",
  format: "cjs" as const,
  external: ["electron"],
  sourcemap: true,
};

async function main() {
  await build({
    ...shared,
    entryPoints: [path.resolve(process.cwd(), "desktop", "main.ts")],
    outfile: path.join(outDir, "main.cjs"),
  });

  await build({
    ...shared,
    entryPoints: [path.resolve(process.cwd(), "desktop", "preload.ts")],
    outfile: path.join(outDir, "preload.cjs"),
  });

  await build({
    ...shared,
    entryPoints: [path.resolve(process.cwd(), "desktop", "ws-server.ts")],
    outfile: path.join(outDir, "ws-server.cjs"),
  });

  const assetsSrc = path.resolve(process.cwd(), "desktop", "assets");
  if (fs.existsSync(assetsSrc)) {
    const assetsDest = path.join(outDir, "assets");
    fs.mkdirSync(assetsDest, { recursive: true });
    for (const entry of fs.readdirSync(assetsSrc)) {
      fs.copyFileSync(path.join(assetsSrc, entry), path.join(assetsDest, entry));
    }
  }

  console.log(`desktop-build: wrote ${path.join(outDir, "main.cjs")}, preload.cjs, ws-server.cjs, and assets`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
