import { app, BrowserWindow, ipcMain, Notification, shell, type IpcMainInvokeEvent } from "electron";
import { createMainWindow, createSessionWindow, failureHtml, loadingHtml } from "./window";
import { importExistingDatabase, installAppMenu } from "./menu";
import { installTray, setTrayStatus } from "./tray";
import { createNotifyState, sanitizeNotifyPayload, shouldNotify } from "./notifications";
import {
  getDesktopDoctorReport,
  getRuntimeHandle,
  restartDesktopRuntime,
  startDesktopRuntime,
  stopDesktopRuntime,
} from "./runtime";
import { checkDesktopUpdates, downloadDesktopUpdate } from "./update";
import { canonicalChannel, isTrustedIpcSender, type DesktopIpcAction } from "./security";
import { DEEPLINK_PROTOCOL, deepLinkFromArgv, parseDeepLink } from "./deeplink";

let mainWindow: BrowserWindow | null = null;
let quitting = false;
const notifyState = createNotifyState();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const sessionWindows = new Map<string, BrowserWindow>();

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(DEEPLINK_PROTOCOL, process.execPath, [process.argv[1]]);
} else {
  app.setAsDefaultProtocolClient(DEEPLINK_PROTOCOL);
}

/** Route a disp8ch:// deep link to the right window/navigation. */
function handleDeepLink(rawUrl: string | null): void {
  if (!rawUrl) return;
  const result = parseDeepLink(rawUrl);
  if (result.action === "open-session") {
    openSessionWindow({ sessionId: result.sessionId });
    return;
  }
  if (result.action === "navigate" && mainWindow) {
    const origin = getRuntimeOrigin();
    mainWindow.show();
    mainWindow.focus();
    if (origin) mainWindow.loadURL(`${origin}${result.route}`).catch(() => {});
  }
}

/**
 * Open (or focus an existing) read-only watch window for a session, reusing the
 * same /chat renderer with a desktop query flag. Duplicate windows for the same
 * session are prevented.
 */
function openSessionWindow(payload: unknown): { ok: boolean; reason?: string } {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  if (!sessionId) return { ok: false, reason: "missing-session" };
  const origin = getRuntimeOrigin();
  if (!origin) return { ok: false, reason: "runtime-not-ready" };

  const existing = sessionWindows.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { ok: true };
  }

  const win = createSessionWindow(getRuntimeOrigin);
  sessionWindows.set(sessionId, win);
  win.on("closed", () => sessionWindows.delete(sessionId));
  const interactive = record.interactive === true;
  const url = `${origin}/chat?sessionId=${encodeURIComponent(sessionId)}&desktopWatch=1${interactive ? "" : "&readOnly=1"}`;
  win.loadURL(url).catch(() => {});
  return { ok: true };
}

function getRuntimeOrigin(): string | null {
  const handle = getRuntimeHandle();
  if (!handle) return null;
  try {
    return new URL(handle.url).origin;
  } catch {
    return null;
  }
}

function loadRuntimeUrl() {
  const handle = getRuntimeHandle();
  if (!mainWindow || !handle) return;
  mainWindow.loadURL(`${handle.url}/onboarding`).catch((error) => {
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(failureHtml(String(error)))}`);
  });
}

/** Register a canonical IPC handler with trusted-sender validation. */
function registerIpc(
  action: DesktopIpcAction,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  const guarded = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const senderUrl = event.senderFrame?.url ?? "";
    if (!isTrustedIpcSender(senderUrl, getRuntimeOrigin())) {
      throw new Error(`Rejected ${action}: untrusted IPC sender (${senderUrl || "unknown"}).`);
    }
    return handler(event, ...args);
  };
  ipcMain.handle(canonicalChannel(action), guarded);
}

function registerIpcHandlers(): void {
  registerIpc("get-health", () => getDesktopDoctorReport());
  registerIpc("run-doctor", () => getDesktopDoctorReport());
  registerIpc("check-updates", () => checkDesktopUpdates({ currentVersion: app.getVersion() }));
  registerIpc("download-update", () => downloadDesktopUpdate({ currentVersion: app.getVersion() }));
  registerIpc("restart-runtime", async () => {
    const handle = await restartDesktopRuntime();
    loadRuntimeUrl();
    return { ok: true, url: handle.url };
  });
  // Native-picker-owned import. The renderer can no longer supply an arbitrary
  // source path; the main process owns the file dialog and validation.
  registerIpc("import-database", () => importExistingDatabase(loadRuntimeUrl));
  registerIpc("open-data-dir", () => {
    const handle = getRuntimeHandle();
    return handle ? shell.openPath(handle.dataDir) : "runtime not started";
  });
  registerIpc("open-logs-dir", () => {
    const handle = getRuntimeHandle();
    return handle ? shell.openPath(handle.logsDir) : "runtime not started";
  });
  registerIpc("notify", (_event, payload) => {
    const data = sanitizeNotifyPayload(payload);
    if (!data) return { shown: false, reason: "invalid" };
    const focused = mainWindow?.isFocused() ?? false;
    const decision = shouldNotify({
      id: data.id,
      severity: data.severity,
      windowFocused: focused,
      now: Date.now(),
      state: notifyState,
    });
    if (!decision.show) return { shown: false, reason: decision.reason };
    if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };
    const notification = new Notification({ title: data.title, body: data.body });
    notification.on("click", () => {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
      const origin = getRuntimeOrigin();
      if (origin) mainWindow.loadURL(`${origin}${data.href}`).catch(() => {});
    });
    notification.show();
    return { shown: true, reason: "show" };
  });
  registerIpc("set-attention", (_event, payload) => {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const count = Number(record.count) || 0;
    const critical = Number(record.critical) || 0;
    if (process.platform === "darwin" || process.platform === "linux") {
      try {
        app.setBadgeCount(count);
      } catch {
        /* badge unsupported */
      }
    }
    setTrayStatus(count > 0 ? `${count} need attention${critical ? ` (${critical} critical)` : ""}` : "idle");
    return { ok: true };
  });
  registerIpc("open-session-window", (_event, payload) => openSessionWindow(payload));
}

async function boot() {
  mainWindow = createMainWindow(getRuntimeOrigin);
  installAppMenu(() => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    loadRuntimeUrl();
  });
  installTray(mainWindow);

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  mainWindow.on("close", (event) => {
    if (quitting || process.platform === "darwin") return;
    event.preventDefault();
    mainWindow?.hide();
  });

  try {
    await startDesktopRuntime();
    loadRuntimeUrl();
    // Handle a protocol launch (Windows passes the deep link in argv).
    handleDeepLink(deepLinkFromArgv(process.argv));
  } catch (error) {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(failureHtml(String(error)))}`);
  }
}

app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  handleDeepLink(deepLinkFromArgv(argv));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Defense in depth: block creation of any window outside the main window.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  boot().catch((error) => console.error(error));
});

registerIpcHandlers();

app.whenReady().then(boot).catch((error) => {
  console.error(error);
  app.quit();
});

process.on("beforeExit", () => {
  stopDesktopRuntime().catch(() => {});
});
