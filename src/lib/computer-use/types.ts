/**
 * Computer-use capability types. Provider-neutral so a Cua backend can be used
 * now and other adapters added later. Desktop control is OPTIONAL, gated behind
 * explicit enablement, and audited via the session store. It is deliberately
 * separate from browser automation.
 */

export type ComputerUseInstallState = {
  installed: boolean;
  driver: string | null;
  version: string | null;
  reason: string;
};

export type ComputerUseDoctorStatus = "pass" | "degraded" | "failed" | "missing";

export type ComputerUseDoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export type ComputerUseDoctorReport = {
  overall: ComputerUseDoctorStatus;
  checks: ComputerUseDoctorCheck[];
  driver: string | null;
  generatedAt: string;
};

export type ComputerUseDoctorOptions = {
  driverCommand?: string;
};

export type ComputerUseSessionOptions = {
  label?: string;
  agentId?: string | null;
  displayId?: string | null;
  /** Privacy-preserving by default: upstream telemetry is opt-in. */
  telemetry?: boolean;
};

export type ComputerUseSessionStatus = "active" | "paused" | "stopped" | "error";

export type ComputerUseSession = {
  id: string;
  status: ComputerUseSessionStatus;
  label: string | null;
  agentId: string | null;
  driver: string | null;
  startedAt: string;
  endedAt: string | null;
  lastScreenshotPath: string | null;
  activeApp: string | null;
};

export type ComputerObservation = {
  ok: boolean;
  sessionId: string;
  mode: ComputerCaptureMode;
  pid: number | null;
  windowId: number | null;
  activeApp: string | null;
  screenshotPath: string | null;
  text: string | null;
  elementCount: number;
  elements: ComputerUiElement[];
  windows: ComputerWindow[];
  detail: string | null;
  observedAt: string;
};

export type ComputerCaptureMode = "som" | "vision" | "ax";

export type ComputerUiElement = {
  elementIndex: number;
  elementToken: string | null;
  role: string;
  label: string;
  frame: { x: number; y: number; width: number; height: number } | null;
  depth: number | null;
};

export type ComputerWindow = {
  pid: number;
  windowId: number;
  appName: string | null;
  title: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  isOnScreen: boolean | null;
  zIndex: number | null;
};

export type ComputerApp = {
  pid: number;
  name: string;
  running: boolean;
  active: boolean;
  kind: string | null;
  launchPath: string | null;
  bundleId: string | null;
};

export type ComputerObserveOptions = {
  mode?: ComputerCaptureMode;
  pid?: number;
  windowId?: number;
  query?: string;
  maxElements?: number;
  maxDepth?: number;
  /** Human-facing app or window title hint resolved against list_windows. */
  windowHint?: string;
};

export type ComputerClickAction = {
  pid?: number;
  window_id?: number;
  element_index?: number;
  element_token?: string;
  x?: number;
  y?: number;
  target?: string;
  button?: "left" | "right" | "middle";
};
export type ComputerTypeAction = {
  pid?: number;
  window_id?: number;
  element_index?: number;
  element_token?: string;
  text: string;
  target?: string;
};
export type ComputerHotkeyAction = { pid?: number; window_id?: number; keys: string[] };
export type ComputerScrollAction = {
  pid?: number;
  window_id?: number;
  element_index?: number;
  element_token?: string;
  dx?: number;
  dy?: number;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  by?: "line" | "page";
};
export type ComputerDragAction = {
  pid?: number;
  window_id?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  target?: string;
};

export type ComputerActionResult = {
  ok: boolean;
  detail: string;
  screenshotPath?: string | null;
  activeApp?: string | null;
  data?: unknown;
};

export interface ComputerUseAdapter {
  id: string;
  label: string;
  isInstalled(): Promise<ComputerUseInstallState>;
  doctor(options?: ComputerUseDoctorOptions): Promise<ComputerUseDoctorReport>;
  startSession(options: ComputerUseSessionOptions): Promise<ComputerUseSession>;
  observe(sessionId: string, options?: ComputerObserveOptions): Promise<ComputerObservation>;
  listApps(sessionId: string): Promise<ComputerActionResult>;
  launchApp(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult>;
  focusApp(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult>;
  click(sessionId: string, action: ComputerClickAction): Promise<ComputerActionResult>;
  typeText(sessionId: string, action: ComputerTypeAction): Promise<ComputerActionResult>;
  setValue(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult>;
  hotkey(sessionId: string, action: ComputerHotkeyAction): Promise<ComputerActionResult>;
  scroll(sessionId: string, action: ComputerScrollAction): Promise<ComputerActionResult>;
  drag(sessionId: string, action: ComputerDragAction): Promise<ComputerActionResult>;
  zoom(sessionId: string, action: Record<string, unknown>): Promise<ComputerActionResult>;
  wait(sessionId: string, ms: number): Promise<ComputerActionResult>;
  stopSession(sessionId: string): Promise<void>;
}
