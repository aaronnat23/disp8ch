import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["build"], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DISP8CH_STANDALONE_BUILD: "1" },
});

if (result.error) {
  console.error(`desktop-standalone-build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
