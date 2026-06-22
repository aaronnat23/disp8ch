import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getInstallPaths, buildRuntimeEnv, type InstallChannel } from "./install-paths";
import { fetchHealth } from "./runtime-health";

export type RuntimeMode = "dev" | "standalone";

export type RuntimeLaunchOptions = {
  mode?: RuntimeMode;
  installChannel?: InstallChannel;
  cwd?: string;
  openBrowser?: boolean;
  preferredPort?: number;
  preferredWsPort?: number;
  healthTimeoutMs?: number;
};

export type RuntimeHandle = {
  url: string;
  healthUrl: string;
  port: number;
  wsPort: number;
  dataDir: string;
  logsDir: string;
  processes: ChildProcess[];
};

function parseArgs(argv: string[]) {
  const filtered = argv.filter((arg) => arg !== "--");
  const valueAfter = (flag: string) => {
    const index = filtered.indexOf(flag);
    return index >= 0 ? filtered[index + 1] : undefined;
  };
  const modeValue = valueAfter("--mode");
  return {
    mode: modeValue === "standalone" ? "standalone" as const : "dev" as const,
    openBrowser: !filtered.includes("--no-open"),
    json: filtered.includes("--json"),
    port: Number(valueAfter("--port") || process.env.PORT || 3100),
    wsPort: Number(valueAfter("--ws-port") || process.env.WS_PORT || 3101),
    installChannel: (valueAfter("--install-channel") || process.env.DISP8CH_INSTALL_CHANNEL || "source") as InstallChannel,
  };
}

export async function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function pickFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${preferred} to ${preferred + 49}`);
}

function openUrl(url: string) {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function spawnLogged(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const logStream = fs.createWriteStream(options.logFile, { flags: "a" });
  logStream.write(`\n\n[${new Date().toISOString()}] ${command} ${args.join(" ")}\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.on("exit", (code, signal) => {
    logStream.write(`\n[${new Date().toISOString()}] exited code=${String(code)} signal=${String(signal)}\n`);
  });
  return child;
}

export function buildStandaloneSidecarEnv(
  env: NodeJS.ProcessEnv = process.env,
  isElectronRuntime = Boolean(process.versions.electron),
): NodeJS.ProcessEnv {
  if (!isElectronRuntime) return env;
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

export async function startDisp8chRuntime(options: RuntimeLaunchOptions = {}): Promise<RuntimeHandle> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const installChannel = options.installChannel || "source";
  const paths = getInstallPaths({ channel: installChannel, appRoot: cwd });
  const port = await pickFreePort(options.preferredPort || Number(process.env.PORT || 3100));
  const wsPort = await pickFreePort(options.preferredWsPort || Number(process.env.WS_PORT || 3101));
  const url = `http://127.0.0.1:${port}`;
  const healthUrl = `${url}/api/health`;
  const env = buildRuntimeEnv(paths, {
    PORT: String(port),
    WS_PORT: String(wsPort),
    DISP8CH_INSTALL_CHANNEL: installChannel,
  });
  const logFile = path.join(paths.logsDir, "runtime.log");
  const mode = options.mode || "dev";
  const processes: ChildProcess[] = [];

  if (mode === "standalone") {
    const serverPath = path.join(cwd, ".next", "standalone", "server.js");
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Standalone server missing at ${serverPath}. Run pnpm build first.`);
    }
    const sidecarEnv = buildStandaloneSidecarEnv(env);
    processes.push(spawnLogged(process.execPath, [serverPath], { cwd, env: sidecarEnv, logFile }));
    const bundledWsPath = path.join(cwd, ".desktop", "ws-server.cjs");
    if (fs.existsSync(bundledWsPath)) {
      processes.push(spawnLogged(process.execPath, [bundledWsPath], { cwd, env: sidecarEnv, logFile }));
    } else {
      processes.push(spawnLogged(process.execPath, ["--import", "tsx", path.join(cwd, "server", "ws.ts")], { cwd, env: sidecarEnv, logFile }));
    }
  } else {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    processes.push(spawnLogged(pnpmCommand, ["dev"], { cwd, env, logFile }));
  }

  const deadline = Date.now() + (options.healthTimeoutMs || 90000);
  let lastSummary = "not checked";
  while (Date.now() < deadline) {
    const check = await fetchHealth(healthUrl, 2500);
    lastSummary = check.summary;
    if (check.status !== "fail") {
      if (options.openBrowser) openUrl(`${url}/onboarding`);
      return { url, healthUrl, port, wsPort, dataDir: paths.dataDir, logsDir: paths.logsDir, processes };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  await stopDisp8chRuntime({ url, healthUrl, port, wsPort, dataDir: paths.dataDir, logsDir: paths.logsDir, processes });
  throw new Error(`Runtime did not become healthy: ${lastSummary}`);
}

export async function stopDisp8chRuntime(handle: RuntimeHandle): Promise<void> {
  await Promise.all(handle.processes.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolve();
    }, 5000).unref();
  })));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handle = await startDisp8chRuntime({
    mode: args.mode,
    openBrowser: args.openBrowser,
    preferredPort: args.port,
    preferredWsPort: args.wsPort,
    installChannel: args.installChannel,
  });
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      url: handle.url,
      healthUrl: handle.healthUrl,
      port: handle.port,
      wsPort: handle.wsPort,
      dataDir: handle.dataDir,
      logsDir: handle.logsDir,
    }, null, 2));
  } else {
    console.log(`disp8ch AI running at ${handle.url}`);
    console.log(`Logs: ${handle.logsDir}`);
  }
}

if (process.argv[1] && path.parse(process.argv[1]).name === "runtime-manager") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
