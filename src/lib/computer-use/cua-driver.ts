/**
 * Cua-backed computer-use adapter. Resolves a `cua-driver` command from
 * DISP8CH_CUA_DRIVER_CMD or PATH and speaks JSON to it. If no driver is present,
 * everything reports an honest not-installed/missing state — it never fakes a
 * result. Action execution is gated by the policy + session store at the caller.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildMissingDriverReport, parseDoctorReport, unwrapMcpCallResult } from "./doctor";
import { appendActiveWindowSummary, readActiveWindowSummary } from "./observe-fallback";
import {
  createSessionRecord,
  getSessionRecord,
  recordSessionAction,
  setSessionStatus,
} from "./session-store";
import type {
  ComputerActionResult,
  ComputerApp,
  ComputerClickAction,
  ComputerDragAction,
  ComputerHotkeyAction,
  ComputerObservation,
  ComputerObserveOptions,
  ComputerScrollAction,
  ComputerTypeAction,
  ComputerUseAdapter,
  ComputerUseDoctorOptions,
  ComputerUseDoctorReport,
  ComputerUseInstallState,
  ComputerUseSession,
  ComputerUseSessionOptions,
  ComputerUiElement,
  ComputerWindow,
} from "./types";

export function resolveDriverCommand(override?: string): string | null {
  const explicit = override || process.env.DISP8CH_CUA_DRIVER_CMD;
  if (explicit && explicit.trim()) return explicit.trim();
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(probe, ["cua-driver"], { encoding: "utf8", timeout: 4000 });
    if (result.status === 0) {
      const line = String(result.stdout || "").split(/\r?\n/).find((l) => l.trim());
      return line ? line.trim() : "cua-driver";
    }
  } catch {
    /* probe unavailable */
  }
  return null;
}

function driverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DISP8CH_CUA_TELEMETRY || "").trim())) {
    env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
  }
  return env;
}

function runDriver(driver: string, args: string[], stdin?: string, timeoutMs = 30_000): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(driver, args, {
    encoding: "utf8",
    input: stdin,
    timeout: Math.max(1_000, Math.min(90_000, timeoutMs)),
    env: driverEnv(),
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function parseJsonMaybe(text: string): unknown {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function compactJson(value: unknown, max = 1600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function captureDirectory(sessionId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.resolve(process.cwd(), "data", "computer-use", "captures", safeSession);
}

function persistScreenshot(sessionId: string, base64: unknown): string | null {
  if (typeof base64 !== "string" || base64.length < 32 || base64.length > 32 * 1024 * 1024) return null;
  const dir = captureDirectory(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"), { mode: 0o600 });
  const captures = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of captures.slice(20)) fs.rmSync(path.join(dir, stale.name), { force: true });
  return file;
}

function normalizeElements(value: unknown): ComputerUiElement[] {
  if (!isRecord(value) || !Array.isArray(value.elements)) return [];
  return value.elements.slice(0, 250).filter(isRecord).map((entry) => {
    const frame = isRecord(entry.frame) ? entry.frame : null;
    const x = finiteNumber(frame?.x);
    const y = finiteNumber(frame?.y);
    const width = finiteNumber(frame?.w ?? frame?.width);
    const height = finiteNumber(frame?.h ?? frame?.height);
    return {
      elementIndex: finiteNumber(entry.element_index) ?? -1,
      elementToken: typeof entry.element_token === "string" ? entry.element_token : null,
      role: typeof entry.role === "string" ? entry.role : "Unknown",
      label: typeof entry.label === "string" ? entry.label.slice(0, 500) : "",
      frame: x === null || y === null || width === null || height === null ? null : { x, y, width, height },
      depth: finiteNumber(entry.depth),
    };
  }).filter((entry) => entry.elementIndex >= 0);
}

function normalizeWindows(value: unknown): ComputerWindow[] {
  if (!isRecord(value) || !Array.isArray(value.windows)) return [];
  return value.windows.slice(0, 100).filter(isRecord).flatMap((entry) => {
    const pid = finiteNumber(entry.pid);
    const windowId = finiteNumber(entry.window_id);
    if (pid === null || windowId === null) return [];
    const bounds = isRecord(entry.bounds) ? entry.bounds : entry;
    const x = finiteNumber(bounds.x);
    const y = finiteNumber(bounds.y);
    const width = finiteNumber(bounds.width);
    const height = finiteNumber(bounds.height);
    return [{
      pid,
      windowId,
      appName: typeof entry.app_name === "string" ? entry.app_name : null,
      title: typeof entry.title === "string" ? entry.title : "(untitled)",
      bounds: x === null || y === null || width === null || height === null ? null : { x, y, width, height },
      isOnScreen: typeof entry.is_on_screen === "boolean" ? entry.is_on_screen : null,
      zIndex: finiteNumber(entry.z_index),
    }];
  });
}

function normalizeApps(value: unknown): ComputerApp[] {
  if (!isRecord(value)) return [];
  const raw = Array.isArray(value.apps) ? value.apps : Array.isArray(value.applications) ? value.applications : [];
  return raw.slice(0, 200).filter(isRecord).map((entry) => ({
    pid: finiteNumber(entry.pid) ?? 0,
    name: String(entry.name ?? entry.app_name ?? entry.display_name ?? "Unknown"),
    running: entry.running === true,
    active: entry.active === true,
    kind: typeof entry.kind === "string" ? entry.kind : null,
    launchPath: typeof entry.launch_path === "string" ? entry.launch_path : null,
    bundleId: typeof entry.bundle_id === "string" ? entry.bundle_id : typeof entry.aumid === "string" ? entry.aumid : null,
  }));
}

function notInstalledResult(detail = "Cua driver not installed"): ComputerActionResult {
  return { ok: false, detail, screenshotPath: null };
}

type CuaWindowInfo = {
  pid?: number;
  window_id?: number;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function windowsFromSnapshot(value: unknown): CuaWindowInfo[] {
  if (!isRecord(value) || !Array.isArray(value.windows)) return [];
  return value.windows.filter(isRecord).map((entry) => ({
    pid: typeof entry.pid === "number" ? entry.pid : undefined,
    window_id: typeof entry.window_id === "number" ? entry.window_id : undefined,
    title: typeof entry.title === "string" ? entry.title : undefined,
    x: typeof entry.x === "number" ? entry.x : undefined,
    y: typeof entry.y === "number" ? entry.y : undefined,
    width: typeof entry.width === "number" ? entry.width : undefined,
    height: typeof entry.height === "number" ? entry.height : undefined,
  }));
}

function formatAccessibilitySnapshot(value: unknown): { text: string | null; activeApp: string | null } {
  const windows = windowsFromSnapshot(value)
    .filter((window) => window.pid !== undefined && window.window_id !== undefined)
    .slice(0, 12);
  if (windows.length === 0) return { text: null, activeApp: null };

  const lines = windows.map((window, index) => {
    const bounds =
      [window.x, window.y, window.width, window.height].every((part) => typeof part === "number")
        ? ` bounds=${window.x},${window.y},${window.width}x${window.height}`
        : "";
    return `${index + 1}. ${window.title || "(untitled)"} pid=${window.pid} window_id=${window.window_id}${bounds}`;
  });
  return {
    text: `Visible desktop windows:\n${lines.join("\n")}\nUse pid/window_id from this list for computer_click, computer_type, computer_hotkey, computer_scroll, or computer_drag.`,
    activeApp: windows[0]?.title ?? null,
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildBaseTargetPayload(action: Record<string, unknown>): Record<string, unknown> | null {
  const pid = numeric(action.pid);
  if (pid === undefined) return null;
  const payload: Record<string, unknown> = { pid };
  const windowId = numeric(action.window_id);
  if (windowId !== undefined) payload.window_id = windowId;
  const elementIndex = numeric(action.element_index);
  if (elementIndex !== undefined) payload.element_index = elementIndex;
  const elementToken = stringValue(action.element_token);
  if (elementToken) payload.element_token = elementToken;
  return payload;
}

function normalizeWindowHint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function selectComputerWindowByHint(windows: ComputerWindow[], hint: string): ComputerWindow | null {
  const needle = normalizeWindowHint(hint);
  if (!needle) return null;
  const scored = windows.map((window) => {
    const title = normalizeWindowHint(window.title);
    const app = normalizeWindowHint(window.appName || "");
    let score = 0;
    if (title === needle) score = 100;
    else if (title.includes(needle)) score = 80;
    else if (needle.includes(title) && title.length >= 4) score = 60;
    else if (app === needle) score = 50;
    else if (app.includes(needle) || needle.includes(app)) score = 35;
    if (window.isOnScreen !== false) score += 10;
    return { window, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.window ?? null;
}

const POST_ACTION_VERIFY_KINDS = new Set(["click", "type", "set_value", "hotkey", "scroll", "drag"]);

export class CuaComputerUseAdapter implements ComputerUseAdapter {
  id = "cua";
  label = "Cua";

  async isInstalled(): Promise<ComputerUseInstallState> {
    const driver = resolveDriverCommand();
    if (!driver) {
      return { installed: false, driver: null, version: null, reason: "cua-driver not found on PATH or DISP8CH_CUA_DRIVER_CMD" };
    }
    let version: string | null = null;
    try {
      const v = runDriver(driver, ["--version"]);
      if (v.ok) version = v.stdout.trim() || null;
    } catch {
      /* ignore */
    }
    return { installed: true, driver, version, reason: "cua-driver resolved" };
  }

  async doctor(options?: ComputerUseDoctorOptions): Promise<ComputerUseDoctorReport> {
    const driver = resolveDriverCommand(options?.driverCommand);
    if (!driver) return buildMissingDriverReport();

    // Prefer the Cua MCP `call health_report` path. The direct `doctor` CLI
    // probe can report a false "degraded"/"failed" when launched from a session
    // that cannot open the interactive window station (e.g. a WSL-launched
    // shell: OpenWindowStationW(WinSta0): Access is denied), whereas the MCP
    // health_report runs inside the driver's own session and reports truthfully.
    const viaHealth = this.doctorViaHealthReport(driver);
    if (viaHealth) return viaHealth;

    // Fallback: the direct CLI doctor probe.
    try {
      const out = runDriver(driver, ["doctor", "--json"]);
      if (!out.ok && !out.stdout) return buildMissingDriverReport(out.stderr || "doctor failed");
      const parsed = JSON.parse(out.stdout || "{}");
      return parseDoctorReport(parsed, driver);
    } catch (error) {
      return buildMissingDriverReport(`doctor error: ${String(error)}`);
    }
  }

  /**
   * Try the MCP `call health_report` tool. Returns a normalized report when the
   * driver yields a usable payload, or null so the caller falls back to the
   * direct CLI doctor probe. Never fabricates a pass.
   */
  private doctorViaHealthReport(driver: string): ComputerUseDoctorReport | null {
    try {
      const out = runDriver(driver, ["call", "health_report"]);
      if (!out.stdout.trim()) return null;
      const unwrapped = unwrapMcpCallResult(out.stdout);
      if (!unwrapped) return null;
      const report = parseDoctorReport(unwrapped, driver);
      // Only accept a health_report that actually produced checks; an empty or
      // unparseable payload should fall through to the CLI doctor.
      if (report.overall === "missing") return null;
      return report;
    } catch {
      return null;
    }
  }

  private callTool(driver: string, tool: string, payload: Record<string, unknown> = {}): ComputerActionResult & { parsed?: unknown } {
    const args = Object.keys(payload).length > 0 ? ["call", tool, JSON.stringify(payload)] : ["call", tool];
    const timeoutMs = tool === "launch_app" ? 90_000 : tool === "get_window_state" || tool === "list_apps" ? 45_000 : 30_000;
    const out = runDriver(driver, args, undefined, timeoutMs);
    const parsed = parseJsonMaybe(out.stdout);
    const parsedRecord = isRecord(parsed) ? parsed : null;
    const driverReportedError = Boolean(parsedRecord?.isError || parsedRecord?.error);
    const ok = out.ok && !driverReportedError;
    const summaryPayload = parsedRecord
      ? Object.fromEntries(Object.entries(parsedRecord).map(([key, value]) => [
          key,
          key === "screenshot_png_b64" ? `<png ${typeof value === "string" ? value.length : 0} base64 chars>` : value,
        ]))
      : parsed;
    const detail =
      parsedRecord?.error && typeof parsedRecord.error === "string"
        ? parsedRecord.error
        : out.stdout.trim()
          ? compactJson(summaryPayload)
          : out.stderr.trim() || (ok ? "ok" : `${tool} failed`);
    return { ok, detail, screenshotPath: null, parsed, data: parsed };
  }

  async startSession(options: ComputerUseSessionOptions): Promise<ComputerUseSession> {
    const driver = resolveDriverCommand();
    if (!driver) throw new Error("Cua driver not installed");
    const session = createSessionRecord({ label: options.label ?? null, agentId: options.agentId ?? null, driver });
    const declared = this.callTool(driver, "start_session", { session: session.id });
    recordSessionAction({
      sessionId: session.id,
      kind: "start",
      detail: declared.ok ? "Cua session and agent cursor started" : `Session started without cursor: ${declared.detail}`,
    });
    return session;
  }

  private async action(sessionId: string, kind: string, payload: Record<string, unknown>): Promise<ComputerActionResult> {
    const session = getSessionRecord(sessionId);
    if (!session) return notInstalledResult(`Session not found: ${sessionId}`);
    if (session.status !== "active") return notInstalledResult(`Session is ${session.status}`);
    const driver = session.driver || resolveDriverCommand();
    if (!driver) return notInstalledResult();
    try {
      let result: ComputerActionResult;
      if (kind === "list_apps") {
        const called = this.callTool(driver, "list_apps");
        const apps = normalizeApps(called.parsed);
        result = { ...called, detail: called.ok ? `${apps.length} applications found.` : called.detail, data: { apps } };
      } else if (kind === "launch_app") {
        const allowed = ["name", "path", "launch_path", "bundle_id", "aumid", "urls", "additional_arguments", "start_minimized"];
        const target = Object.fromEntries(allowed.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
        result = Object.keys(target).length > 0
          ? this.callTool(driver, "launch_app", target)
          : notInstalledResult("computer_launch_app requires a name, path, launch_path, bundle_id, aumid, or URL.");
      } else if (kind === "focus_app") {
        const pid = numeric(payload.pid);
        result = pid === undefined
          ? notInstalledResult("computer_focus_app requires pid from computer_list_apps or computer_observe.")
          : this.callTool(driver, "bring_to_front", { pid, ...(numeric(payload.window_id) === undefined ? {} : { window_id: numeric(payload.window_id) }) });
      } else if (kind === "click") {
        const target = buildBaseTargetPayload(payload);
        if (!target) {
          result = notInstalledResult("Cua click requires a pid from computer_observe. Run computer_observe first, then pass pid/window_id or element_index.");
        } else {
          const x = numeric(payload.x);
          const y = numeric(payload.y);
          if (x !== undefined) target.x = x;
          if (y !== undefined) target.y = y;
          const button = stringValue(payload.button);
          const dispatch = stringValue(payload.dispatch);
          if (dispatch) target.dispatch = dispatch;
          if (payload.from_zoom === true) target.from_zoom = true;
          const clicks = numeric(payload.clicks) ?? 1;
          const tool = clicks >= 2 ? "double_click" : button === "right" ? "right_click" : "click";
          result = this.callTool(driver, tool, target);
        }
      } else if (kind === "type") {
        const target = buildBaseTargetPayload(payload);
        const text = stringValue(payload.text);
        if (!target || !text) {
          result = notInstalledResult("Cua type_text requires text and a pid from computer_observe. Run computer_observe first, then pass pid/window_id.");
        } else {
          target.text = text;
          const dispatch = stringValue(payload.dispatch);
          if (dispatch) target.dispatch = dispatch;
          if (payload.from_zoom === true) target.from_zoom = true;
          result = this.callTool(driver, "type_text", target);
        }
      } else if (kind === "set_value") {
        const target = buildBaseTargetPayload(payload);
        const value = typeof payload.value === "string" ? payload.value : null;
        if (!target || value === null) {
          result = notInstalledResult("computer_set_value requires pid, value, and an element index/token from the latest computer_observe snapshot.");
        } else {
          target.value = value;
          result = this.callTool(driver, "set_value", target);
        }
      } else if (kind === "hotkey") {
        const target = buildBaseTargetPayload(payload);
        const keys = Array.isArray(payload.keys) ? payload.keys.map((key) => String(key).toLowerCase()) : [];
        if (!target || keys.length === 0) {
          result = notInstalledResult("Cua hotkey requires keys and a pid from computer_observe. Run computer_observe first, then pass pid/window_id.");
        } else {
          target.keys = keys;
          const dispatch = stringValue(payload.dispatch);
          if (dispatch) target.dispatch = dispatch;
          result = this.callTool(driver, "hotkey", target);
        }
      } else if (kind === "scroll") {
        const target = buildBaseTargetPayload(payload);
        if (!target) {
          result = notInstalledResult("Cua scroll requires a pid from computer_observe. Run computer_observe first, then pass pid/window_id.");
        } else {
          const explicitDirection = stringValue(payload.direction);
          const dy = numeric(payload.dy);
          const dx = numeric(payload.dx);
          target.direction =
            explicitDirection ||
            (dy !== undefined && dy < 0 ? "up" : dy !== undefined && dy > 0 ? "down" : dx !== undefined && dx < 0 ? "left" : "right");
          target.amount = Math.max(1, Math.min(50, Math.abs(Math.round(numeric(payload.amount) ?? dy ?? dx ?? 3))));
          const by = stringValue(payload.by);
          if (by === "line" || by === "page") target.by = by;
          result = this.callTool(driver, "scroll", target);
        }
      } else if (kind === "drag") {
        const target = buildBaseTargetPayload(payload);
        if (!target) {
          result = notInstalledResult("Cua drag requires a pid from computer_observe. Run computer_observe first, then pass pid/window_id.");
        } else {
          const fromX = numeric(payload.from_x) ?? numeric(payload.fromX);
          const fromY = numeric(payload.from_y) ?? numeric(payload.fromY);
          const toX = numeric(payload.to_x) ?? numeric(payload.toX);
          const toY = numeric(payload.to_y) ?? numeric(payload.toY);
          if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
            result = notInstalledResult("Cua drag requires from_x/from_y/to_x/to_y coordinates in the target window.");
          } else {
            target.from_x = fromX;
            target.from_y = fromY;
            target.to_x = toX;
            target.to_y = toY;
            const dispatch = stringValue(payload.dispatch);
            if (dispatch) target.dispatch = dispatch;
            if (payload.from_zoom === true) target.from_zoom = true;
            result = this.callTool(driver, "drag", target);
          }
        }
      } else if (kind === "zoom") {
        const target = buildBaseTargetPayload(payload);
        const x1 = numeric(payload.x1);
        const y1 = numeric(payload.y1);
        const x2 = numeric(payload.x2);
        const y2 = numeric(payload.y2);
        if (!target || x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
          result = notInstalledResult("computer_zoom requires pid, window_id, x1, y1, x2, and y2.");
        } else {
          const called = this.callTool(driver, "zoom", { ...target, x1, y1, x2, y2 });
          const parsed = isRecord(called.parsed) ? called.parsed : null;
          const screenshotPath = persistScreenshot(sessionId, parsed?.screenshot_png_b64);
          result = { ...called, screenshotPath, detail: screenshotPath ? `Zoom capture saved to ${screenshotPath}` : called.detail };
        }
      } else {
        result = notInstalledResult(`Unknown computer-use action: ${kind}`);
      }
      if (result.ok && POST_ACTION_VERIFY_KINDS.has(kind) && payload.verify_after !== false) {
        const pid = numeric(payload.pid);
        const windowId = numeric(payload.window_id);
        const verifyQuery = stringValue(payload.verify_query);
        let verificationData: Record<string, unknown> = {
          captured: false,
          verified: false,
          query: verifyQuery ?? null,
          reason: "A pid and window_id are required for post-action verification.",
        };
        if (pid !== undefined && windowId !== undefined) {
          const verification = this.callTool(driver, "get_window_state", {
            pid,
            window_id: windowId,
            capture_mode: "ax",
            max_elements: 80,
            max_depth: 16,
          });
          if (verification.ok && isRecord(verification.parsed)) {
            const tree = typeof verification.parsed.tree_markdown === "string" ? verification.parsed.tree_markdown.slice(0, 5000) : "";
            const matched = verifyQuery ? tree.toLowerCase().includes(verifyQuery.toLowerCase()) : false;
            verificationData = {
              captured: true,
              verified: matched,
              query: verifyQuery ?? null,
              reason: verifyQuery
                ? matched
                  ? `Expected state matched: ${verifyQuery}`
                  : `Post-action state did not contain: ${verifyQuery}`
                : "Post-action state was captured, but no expected state was supplied.",
              evidence: tree.slice(0, 2000) || "UI state captured without accessibility text.",
            };
            result.detail = `${result.detail}\n${verificationData.reason}`;
          } else {
            verificationData = {
              captured: false,
              verified: false,
              query: verifyQuery ?? null,
              reason: `Post-action capture failed: ${verification.detail}`,
            };
          }
        }
        result.data = {
          ...(isRecord(result.data) ? result.data : {}),
          verification: verificationData,
        };
      }
      recordSessionAction({
        sessionId,
        kind,
        detail: result.detail,
        screenshotPath: result.screenshotPath,
        activeApp: result.activeApp ?? null,
      });
      return result;
    } catch (error) {
      return notInstalledResult(`action error: ${String(error)}`);
    }
  }

  async observe(sessionId: string, options: ComputerObserveOptions = {}): Promise<ComputerObservation> {
    const session = getSessionRecord(sessionId);
    const mode = options.mode ?? "som";
    const empty: ComputerObservation = {
      ok: false,
      sessionId,
      mode,
      pid: options.pid ?? null,
      windowId: options.windowId ?? null,
      activeApp: session?.activeApp ?? null,
      screenshotPath: null,
      text: null,
      elementCount: 0,
      elements: [],
      windows: [],
      detail: session ? `Session is ${session.status}` : `Session not found: ${sessionId}`,
      observedAt: new Date().toISOString(),
    };
    if (!session || session.status !== "active") return empty;
    const driver = session.driver || resolveDriverCommand();
    if (!driver) return { ...empty, detail: "Cua driver not installed" };

    let called: ReturnType<CuaComputerUseAdapter["callTool"]>;
    let windows: ComputerWindow[] = [];
    let elements: ComputerUiElement[] = [];
    let screenshotPath: string | null = null;
    let text: string | null = null;
    let activeApp: string | null = null;
    let resolvedPid = options.pid ?? null;
    let resolvedWindowId = options.windowId ?? null;
    if (options.pid !== undefined && options.windowId !== undefined) {
      called = this.callTool(driver, "get_window_state", {
        pid: options.pid,
        window_id: options.windowId,
        capture_mode: mode,
        max_elements: Math.max(1, Math.min(500, Math.round(options.maxElements ?? 200))),
        max_depth: Math.max(1, Math.min(40, Math.round(options.maxDepth ?? 20))),
        ...(options.query ? { query: options.query.slice(0, 200) } : {}),
      });
      const parsed = isRecord(called.parsed) ? called.parsed : null;
      elements = normalizeElements(parsed);
      screenshotPath = persistScreenshot(sessionId, parsed?.screenshot_png_b64);
      text = typeof parsed?.tree_markdown === "string" ? parsed.tree_markdown.slice(0, 12_000) : null;
      activeApp = `pid ${options.pid} / window ${options.windowId}`;
      if (!text && screenshotPath) text = `Screenshot captured at ${screenshotPath}. Use vision analysis when visual interpretation is needed.`;
    } else {
      called = this.callTool(driver, "list_windows");
      windows = normalizeWindows(called.parsed);
      const matchedWindow = options.windowHint ? selectComputerWindowByHint(windows, options.windowHint) : null;
      if (matchedWindow) {
        resolvedPid = matchedWindow.pid;
        resolvedWindowId = matchedWindow.windowId;
        called = this.callTool(driver, "get_window_state", {
          pid: matchedWindow.pid,
          window_id: matchedWindow.windowId,
          capture_mode: mode,
          max_elements: Math.max(1, Math.min(500, Math.round(options.maxElements ?? 200))),
          max_depth: Math.max(1, Math.min(40, Math.round(options.maxDepth ?? 20))),
          ...(options.query ? { query: options.query.slice(0, 200) } : {}),
        });
        const parsed = isRecord(called.parsed) ? called.parsed : null;
        elements = normalizeElements(parsed);
        screenshotPath = persistScreenshot(sessionId, parsed?.screenshot_png_b64);
        text = typeof parsed?.tree_markdown === "string" ? parsed.tree_markdown.slice(0, 12_000) : null;
        activeApp = matchedWindow.appName || matchedWindow.title;
        if (!text && screenshotPath) text = `Screenshot captured at ${screenshotPath}. Use vision analysis when visual interpretation is needed.`;
      } else {
        const formatted = formatAccessibilitySnapshot(called.parsed);
        activeApp = windows[0]?.appName || windows[0]?.title || formatted.activeApp;
        text = windows.length > 0
          ? `Visible desktop windows:\n${windows.slice(0, 30).map((window, index) => `${index + 1}. ${window.appName || "app"} — ${window.title} pid=${window.pid} window_id=${window.windowId}`).join("\n")}\nCall computer_observe again with pid/window_id and mode som, ax, or vision.`
          : formatted.text;
      }
    }
    // An exact pid/window capture is authoritative. Adding the unrelated
    // foreground-window fallback here can contradict the requested target and
    // make the model discard valid accessibility evidence.
    const exactWindowCaptured = resolvedPid !== null && resolvedWindowId !== null;
    const fallback = called.ok && !exactWindowCaptured ? readActiveWindowSummary() : null;
    text = called.ok ? appendActiveWindowSummary(text || called.detail, fallback) : null;
    recordSessionAction({
      sessionId,
      kind: "observe",
      risk: "read",
      detail: text || called.detail,
      screenshotPath,
      activeApp: activeApp ?? fallback?.app ?? fallback?.title ?? null,
    });
    return {
      ok: called.ok,
      sessionId,
      mode,
      pid: resolvedPid,
      windowId: resolvedWindowId,
      activeApp: activeApp ?? fallback?.app ?? fallback?.title ?? null,
      screenshotPath,
      text,
      elementCount: elements.length,
      elements,
      windows,
      detail: called.detail,
      observedAt: new Date().toISOString(),
    };
  }

  listApps(sessionId: string): Promise<ComputerActionResult> {
    return this.action(sessionId, "list_apps", {});
  }
  launchApp(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult> {
    return this.action(sessionId, "launch_app", action);
  }
  focusApp(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult> {
    return this.action(sessionId, "focus_app", action);
  }

  click(sessionId: string, action: ComputerClickAction): Promise<ComputerActionResult> {
    return this.action(sessionId, "click", { ...action });
  }
  typeText(sessionId: string, action: ComputerTypeAction): Promise<ComputerActionResult> {
    return this.action(sessionId, "type", { ...action });
  }
  setValue(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult> {
    return this.action(sessionId, "set_value", action);
  }
  hotkey(sessionId: string, action: ComputerHotkeyAction): Promise<ComputerActionResult> {
    return this.action(sessionId, "hotkey", { ...action });
  }
  scroll(sessionId: string, action: ComputerScrollAction): Promise<ComputerActionResult> {
    return this.action(sessionId, "scroll", { ...action });
  }
  drag(sessionId: string, action: ComputerDragAction): Promise<ComputerActionResult> {
    return this.action(sessionId, "drag", { ...action });
  }
  zoom(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult> {
    return this.action(sessionId, "zoom", action);
  }
  async wait(sessionId: string, ms: number): Promise<ComputerActionResult> {
    recordSessionAction({ sessionId, kind: "wait", detail: `wait ${ms}ms` });
    return { ok: true, detail: `waited ${ms}ms` };
  }
  async stopSession(sessionId: string): Promise<void> {
    const session = getSessionRecord(sessionId);
    const driver = session?.driver || resolveDriverCommand();
    if (driver) this.callTool(driver, "end_session", { session: sessionId });
    setSessionStatus(sessionId, "stopped");
    recordSessionAction({ sessionId, kind: "stop", detail: "session stopped" });
  }
}
