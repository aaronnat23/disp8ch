import os from "node:os";
import path from "node:path";

export type InstallChannel = "desktop" | "script" | "source" | "unknown";

export type Disp8chInstallPaths = {
  platform: NodeJS.Platform;
  homeDir: string;
  dataDir: string;
  runtimeDir: string;
  appDir: string;
  databasePath: string;
  logsDir: string;
  memoryDir: string;
  workspaceDir: string;
};

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function getDefaultDataDir(platform: NodeJS.Platform = process.platform): string {
  if (process.env.DISP8CH_DATA_DIR) return path.resolve(process.env.DISP8CH_DATA_DIR);
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "disp8ch AI");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "disp8ch AI");
  }
  return path.join(xdgDataHome(), "disp8ch");
}

export function getInstallPaths(options: {
  platform?: NodeJS.Platform;
  channel?: InstallChannel;
  appRoot?: string;
} = {}): Disp8chInstallPaths {
  const platform = options.platform ?? process.platform;
  const homeDir = os.homedir();
  const dataDir = getDefaultDataDir(platform);
  const runtimeDir = process.env.DISP8CH_RUNTIME_DIR
    ? path.resolve(process.env.DISP8CH_RUNTIME_DIR)
    : path.join(dataDir, "runtime");
  const appDir = options.appRoot
    ? path.resolve(options.appRoot)
    : process.env.DISP8CH_APP_DIR
      ? path.resolve(process.env.DISP8CH_APP_DIR)
      : path.join(dataDir, "app");
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(dataDir, "disp8ch.db");
  const logsDir = process.env.DISP8CH_LOG_DIR
    ? path.resolve(process.env.DISP8CH_LOG_DIR)
    : path.join(dataDir, "logs");
  const memoryDir = process.env.MEMORY_PATH
    ? path.resolve(process.env.MEMORY_PATH)
    : path.join(dataDir, "memories");
  const workspaceDir = process.env.WORKSPACE_PATH
    ? path.resolve(process.env.WORKSPACE_PATH)
    : path.join(dataDir, "workspace");

  return {
    platform,
    homeDir,
    dataDir,
    runtimeDir,
    appDir,
    databasePath,
    logsDir,
    memoryDir,
    workspaceDir,
  };
}

export function buildRuntimeEnv(
  paths: Disp8chInstallPaths,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    DATABASE_PATH: paths.databasePath,
    MEMORY_PATH: paths.memoryDir,
    WORKSPACE_PATH: paths.workspaceDir,
    DISP8CH_DATA_DIR: paths.dataDir,
    DISP8CH_RUNTIME_DIR: paths.runtimeDir,
  };
}
