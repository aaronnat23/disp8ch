/**
 * Computer-use agent tools. Distinct from browser tools (never overloaded).
 * Each call is policy-classified; approval-required actions return a
 * needs-approval result instead of executing, and every call is audited via the
 * session store. Wire `executeComputerUseTool` into the agent tool loop behind
 * the computer-use enablement gate.
 */
import { computerUseEnabled, getComputerUseAdapter } from "./adapter";
import { classifyComputerAction, type ComputerActionKind } from "./policy";
import { recordSessionAction } from "./session-store";
import type { ComputerActionResult } from "./types";

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_observe",
  "computer_list_apps",
  "computer_launch_app",
  "computer_focus_app",
  "computer_click",
  "computer_type",
  "computer_set_value",
  "computer_hotkey",
  "computer_scroll",
  "computer_drag",
  "computer_zoom",
  "computer_wait",
  "computer_stop",
] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

const TOOL_TO_KIND: Record<ComputerUseToolName, ComputerActionKind> = {
  computer_observe: "observe",
  computer_list_apps: "list_apps",
  computer_launch_app: "launch_app",
  computer_focus_app: "focus_app",
  computer_click: "click",
  computer_type: "type",
  computer_set_value: "set_value",
  computer_hotkey: "hotkey",
  computer_scroll: "scroll",
  computer_drag: "drag",
  computer_zoom: "zoom",
  computer_wait: "wait",
  computer_stop: "stop",
};

export function getComputerUseToolKind(tool: ComputerUseToolName): ComputerActionKind {
  return TOOL_TO_KIND[tool];
}

export type ComputerUseToolResult = {
  ok: boolean;
  status: "executed" | "executed_unverified" | "needs_approval" | "blocked" | "failed";
  detail: string;
  classification?: ReturnType<typeof classifyComputerAction>;
};

export async function executeComputerUseTool(input: {
  tool: ComputerUseToolName;
  sessionId: string;
  args: Record<string, unknown>;
  approved?: boolean;
  appHint?: string | null;
}): Promise<ComputerUseToolResult> {
  if (!computerUseEnabled()) {
    return { ok: false, status: "blocked", detail: "Computer use is disabled. Enable it in Settings → Computer Use." };
  }
  const adapter = getComputerUseAdapter();
  const install = await adapter.isInstalled();
  if (!install.installed) {
    return { ok: false, status: "blocked", detail: install.reason };
  }

  const kind = TOOL_TO_KIND[input.tool];
  const classification = classifyComputerAction({
    kind,
    text: typeof input.args.text === "string" ? input.args.text : typeof input.args.value === "string" ? input.args.value : undefined,
    keys: Array.isArray(input.args.keys) ? (input.args.keys as string[]) : undefined,
    target: typeof input.args.target === "string" ? input.args.target : null,
    appHint: input.appHint ?? null,
  });

  if (classification.blocked) {
    recordSessionAction({
      sessionId: input.sessionId,
      kind,
      risk: classification.risk,
      requiresApproval: true,
      approved: false,
      detail: `Blocked: ${classification.reasons.join("; ")}`,
    });
    return {
      ok: false,
      status: "blocked",
      detail: `This ${kind} action is always blocked: ${classification.reasons.join("; ")}`,
      classification,
    };
  }

  if (classification.requiresApproval && !input.approved) {
    recordSessionAction({
      sessionId: input.sessionId,
      kind,
      risk: classification.risk,
      requiresApproval: true,
      approved: null,
      detail: `Awaiting approval: ${classification.reasons.join("; ")}`,
    });
    return {
      ok: false,
      status: "needs_approval",
      detail: `This ${kind} action needs approval: ${classification.reasons.join("; ")}`,
      classification,
    };
  }

  let result: ComputerActionResult;
  switch (kind) {
    case "observe": {
      const obs = await adapter.observe(input.sessionId, {
        mode: input.args.mode === "vision" || input.args.mode === "ax" ? input.args.mode : "som",
        pid: typeof input.args.pid === "number" ? input.args.pid : undefined,
        windowId: typeof input.args.window_id === "number" ? input.args.window_id : undefined,
        query: typeof input.args.query === "string" ? input.args.query : undefined,
        maxElements: typeof input.args.max_elements === "number" ? input.args.max_elements : undefined,
        maxDepth: typeof input.args.max_depth === "number" ? input.args.max_depth : undefined,
        windowHint: typeof input.args.app_hint === "string" ? input.args.app_hint : undefined,
      });
      result = {
        ok: obs.ok,
        detail: obs.ok ? obs.text || "(no text observed)" : obs.detail || "computer_observe failed",
        screenshotPath: obs.screenshotPath,
        activeApp: obs.activeApp,
        data: {
          mode: obs.mode,
          pid: obs.pid,
          windowId: obs.windowId,
          screenshotPath: obs.screenshotPath,
          elementCount: obs.elementCount,
          elements: obs.elements,
          windows: obs.windows,
        },
      };
      break;
    }
    case "list_apps":
      result = await adapter.listApps(input.sessionId);
      break;
    case "launch_app":
      result = await adapter.launchApp(input.sessionId, input.args);
      break;
    case "focus_app":
      result = await adapter.focusApp(input.sessionId, input.args);
      break;
    case "click":
      result = await adapter.click(input.sessionId, input.args as any);
      break;
    case "type":
      result = await adapter.typeText(input.sessionId, input.args as any);
      break;
    case "set_value":
      result = await adapter.setValue(input.sessionId, input.args);
      break;
    case "hotkey":
      result = await adapter.hotkey(input.sessionId, input.args as any);
      break;
    case "scroll":
      result = await adapter.scroll(input.sessionId, input.args as any);
      break;
    case "drag":
      result = await adapter.drag(input.sessionId, input.args as any);
      break;
    case "zoom":
      result = await adapter.zoom(input.sessionId, input.args);
      break;
    case "wait":
      result = await adapter.wait(input.sessionId, Number(input.args.ms) || 500);
      break;
    case "stop":
      await adapter.stopSession(input.sessionId);
      result = { ok: true, detail: "session stopped" };
      break;
    default:
      result = { ok: false, detail: `Unknown computer-use tool: ${input.tool}` };
  }

  const verificationKinds = new Set(["click", "type", "set_value", "hotkey", "scroll", "drag"]);
  const resultData = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : null;
  const verification = resultData?.verification && typeof resultData.verification === "object" && !Array.isArray(resultData.verification)
    ? resultData.verification as Record<string, unknown>
    : null;
  const unverified = result.ok && verificationKinds.has(kind) && verification?.verified !== true;
  const detail = result.data === undefined
    ? result.detail
    : `${result.detail}\n${JSON.stringify(result.data)}`;
  return {
    ok: result.ok,
    status: !result.ok ? "failed" : unverified ? "executed_unverified" : "executed",
    detail: unverified
      ? `The action was dispatched, but its intended outcome is not verified. ${detail}`
      : detail,
    classification,
  };
}
