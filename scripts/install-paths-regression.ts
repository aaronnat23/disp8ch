import assert from "node:assert/strict";
import path from "node:path";
import { buildRuntimeEnv, getInstallPaths } from "./install-paths";

function withEnv<T>(patch: NodeJS.ProcessEnv, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

withEnv({ DISP8CH_DATA_DIR: undefined, DATABASE_PATH: undefined, WORKSPACE_PATH: undefined, MEMORY_PATH: undefined }, () => {
  const win = getInstallPaths({ platform: "win32", appRoot: "C:\\Disp8ch\\app" });
  assert.match(win.dataDir, /disp8ch AI$/);
  assert.match(win.databasePath, /disp8ch\.db$/);

  const mac = getInstallPaths({ platform: "darwin", appRoot: "/Applications/disp8ch AI.app" });
  assert(mac.dataDir.includes(path.join("Library", "Application Support", "disp8ch AI")));

  const linux = getInstallPaths({ platform: "linux", appRoot: "/opt/disp8ch" });
  assert(linux.dataDir.includes(path.join(".local", "share", "disp8ch")));

  const env = buildRuntimeEnv(linux, { PORT: "3310", WS_PORT: "3311" });
  assert.equal(env.DATABASE_PATH, linux.databasePath);
  assert.equal(env.WORKSPACE_PATH, linux.workspaceDir);
  assert.equal(env.MEMORY_PATH, linux.memoryDir);
  assert.equal(env.PORT, "3310");
  assert.equal(env.WS_PORT, "3311");
});

withEnv({ DISP8CH_DATA_DIR: "/tmp/disp8ch-data", DATABASE_PATH: "/tmp/custom.db" }, () => {
  const paths = getInstallPaths({ platform: "linux" });
  assert.equal(paths.dataDir, path.resolve("/tmp/disp8ch-data"));
  assert.equal(paths.databasePath, path.resolve("/tmp/custom.db"));
});

console.log("install-paths-regression: ok");
