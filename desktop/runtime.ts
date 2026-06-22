import path from "node:path";
import { app } from "electron";
import { startDisp8chRuntime, stopDisp8chRuntime, type RuntimeHandle } from "../scripts/runtime-manager";
import { runRuntimeHealth } from "../scripts/runtime-health";
import { resolveDesktopEnv } from "./security";

let runtimeHandle: RuntimeHandle | null = null;

export function resolveDesktopAppRoot(): string {
  if (!app.isPackaged) return path.resolve(__dirname, "..");
  return resolveDesktopEnv("APP_ROOT") || path.join(process.resourcesPath, "app");
}

export async function startDesktopRuntime(): Promise<RuntimeHandle> {
  if (runtimeHandle) return runtimeHandle;
  const appRoot = resolveDesktopAppRoot();
  runtimeHandle = await startDisp8chRuntime({
    cwd: appRoot,
    mode: app.isPackaged ? "standalone" : "dev",
    installChannel: "desktop",
    openBrowser: false,
    healthTimeoutMs: app.isPackaged ? 120000 : 90000,
  });
  return runtimeHandle;
}

export async function stopDesktopRuntime(): Promise<void> {
  if (!runtimeHandle) return;
  const handle = runtimeHandle;
  runtimeHandle = null;
  await stopDisp8chRuntime(handle);
}

export async function restartDesktopRuntime(): Promise<RuntimeHandle> {
  await stopDesktopRuntime();
  return startDesktopRuntime();
}

export async function getDesktopDoctorReport() {
  return runRuntimeHealth({
    url: runtimeHandle?.healthUrl || "http://127.0.0.1:3100/api/health",
    includeHttp: Boolean(runtimeHandle),
  });
}

export function getRuntimeHandle(): RuntimeHandle | null {
  return runtimeHandle;
}
