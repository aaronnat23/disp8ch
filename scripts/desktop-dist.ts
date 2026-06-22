import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  env: { ...process.env, DISP8CH_STANDALONE_BUILD: "1" },
  });
  if (result.error) {
    console.error(`desktop-dist: failed to run ${command} ${args.join(" ")}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function restorePackageInstallIfBuilderMutatedIt() {
  const requiredNextEntries = [
    path.join(root, "node_modules", "next", "dist", "build", "webpack-build", "impl.js"),
    path.join(root, "node_modules", "next", "dist", "pages", "_app.js"),
    path.join(root, "node_modules", "next", "dist", "server", "next.js"),
  ];
  if (requiredNextEntries.every((entry) => fs.existsSync(entry))) return;
  console.warn("desktop-dist: package install integrity check failed after electron-builder; restoring pnpm install");
  run(pnpm, ["install", "--force"]);
}

restorePackageInstallIfBuilderMutatedIt();
run(pnpm, ["desktop:standalone-build"]);
run(pnpm, ["desktop:build"]);
run(pnpm, ["desktop:stage"]);
run(pnpm, ["exec", "electron-builder", ...passthroughArgs]);
restorePackageInstallIfBuilderMutatedIt();
run(pnpm, ["desktop:manifest"]);

console.log(`desktop-dist: wrote artifacts under ${path.join(root, "dist", "desktop")}`);
