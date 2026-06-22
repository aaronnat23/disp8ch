import { nanoid } from "nanoid";
import { Cron } from "croner";

// Guided automation setup.
//
// Converts a plain-language automation definition (cadence + local time, no cron
// syntax) into a NORMAL workflow built from generic nodes plus a cron-trigger.
// The cron-trigger carries { expression, timezone }; the existing cron manager
// (croner) interprets that in the given timezone and is DST-aware. There is no
// second scheduler — guided setup just produces standard workflow/cron records.

export type AutomationCadence = "daily" | "weekdays" | "weekly" | "interval" | "one-time" | "advanced";
export type AutomationKind = "briefing" | "scheduled-workflow" | "health-check";
export type DeliveryChannel = "webchat" | "telegram" | "slack" | "discord";

export interface GuidedAutomationDefinition {
  title: string;
  purpose?: string;
  kind: AutomationKind;
  cadence: AutomationCadence;
  /** Local "HH:MM" (24h). */
  time?: string;
  timezone?: string;
  /** 0=Sun..6=Sat, for weekly. */
  weekday?: number;
  /** Minutes between runs, for interval. */
  intervalMinutes?: number;
  /** ISO date "YYYY-MM-DD", for one-time. */
  date?: string;
  /** Raw cron, for advanced. */
  advancedCron?: string;
  /** Prompt/task for briefing; description otherwise. */
  task?: string;
  /** Target workflow id, for scheduled-workflow. */
  targetWorkflowId?: string;
  /** Agent id for briefing. */
  agentId?: string;
  deliveryChannel?: DeliveryChannel;
  /** Required destination for Telegram/Slack/Discord scheduled delivery. */
  deliveryTarget?: string;
  retryOnFailure?: boolean;
  allowOverlap?: boolean;
}

const CHANNEL_NODE: Record<DeliveryChannel, string> = {
  webchat: "send-webchat",
  telegram: "send-telegram",
  slack: "send-slack",
  discord: "send-discord",
};

function parseHM(time: string | undefined): { h: number; m: number } {
  const [hRaw, mRaw] = String(time || "08:00").split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  return { h, m };
}

const SUPPORTED_INTERVALS = new Set([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440]);

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new GuidedAutomationError(`invalid timezone: ${timezone}`);
  }
}

function validateCron(expression: string, timezone: string): void {
  try {
    const cron = new Cron(expression, { timezone, paused: true });
    cron.stop();
  } catch {
    throw new GuidedAutomationError("advanced cron must be a valid 5-field cron expression");
  }
}

export interface CronResult {
  expression: string;
  timezone: string;
}

/** Convert a cadence + local time/timezone into a cron expression + timezone. */
export function cadenceToCron(def: GuidedAutomationDefinition): CronResult {
  const tz = (def.timezone || "UTC").trim() || "UTC";
  const { h, m } = parseHM(def.time);
  switch (def.cadence) {
    case "daily":
      return { expression: `${m} ${h} * * *`, timezone: tz };
    case "weekdays":
      return { expression: `${m} ${h} * * 1-5`, timezone: tz };
    case "weekly": {
      const dow = Math.min(6, Math.max(0, Number(def.weekday ?? 1)));
      return { expression: `${m} ${h} * * ${dow}`, timezone: tz };
    }
    case "interval": {
      const n = Math.floor(Number(def.intervalMinutes) || 60);
      if (n % 60 === 0) {
        const hours = n / 60;
        return { expression: hours === 24 ? `${m} ${h} * * *` : `0 */${hours} * * *`, timezone: tz };
      }
      return { expression: `*/${n} * * * *`, timezone: tz };
    }
    case "one-time": {
      // Best-effort: fires on the given date/time. (Cron has no true one-shot;
      // disable the automation after it runs, or use a workflow with maxRuns.)
      const [, monthRaw, dayRaw] = String(def.date || "").split("-");
      const day = Number(dayRaw);
      const month = Number(monthRaw);
      return { expression: `${m} ${h} ${day} ${month} *`, timezone: tz };
    }
    case "advanced":
      return { expression: (def.advancedCron || `${m} ${h} * * *`).trim(), timezone: tz };
  }
}

/** Human description of the cadence for review/UI. */
export function describeCadence(def: GuidedAutomationDefinition): string {
  const time = def.time || "08:00";
  const tz = def.timezone || "UTC";
  switch (def.cadence) {
    case "daily":
      return `Every day at ${time} (${tz})`;
    case "weekdays":
      return `Weekdays at ${time} (${tz})`;
    case "weekly": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `Every ${days[def.weekday ?? 1]} at ${time} (${tz})`;
    }
    case "interval":
      return `Every ${def.intervalMinutes || 60} minute(s)`;
    case "one-time":
      return `Once on ${def.date || "today"} at ${time} (${tz})`;
    case "advanced":
      return `Cron: ${def.advancedCron || cadenceToCron(def).expression} (${tz})`;
  }
}

type RawNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };
type RawEdge = { id: string; source: string; target: string; sourceHandle?: string };

export interface GuidedWorkflowDefinition {
  name: string;
  description: string;
  nodes: RawNode[];
  edges: RawEdge[];
}

const n = (id: string, type: string, x: number, y: number, data: Record<string, unknown>): RawNode => ({
  id,
  type,
  position: { x, y },
  data,
});
const e = (source: string, target: string, sourceHandle?: string): RawEdge => ({
  id: `e-${source}-${target}${sourceHandle ? `-${sourceHandle}` : ""}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

export class GuidedAutomationError extends Error {}

/** Validate a guided definition; throws GuidedAutomationError on bad input. */
export function validateGuidedDefinition(def: GuidedAutomationDefinition): void {
  if (!def || typeof def !== "object") throw new GuidedAutomationError("definition is required");
  if (!String(def.title || "").trim()) throw new GuidedAutomationError("title is required");
  if (!["briefing", "scheduled-workflow", "health-check"].includes(def.kind)) {
    throw new GuidedAutomationError(`unknown automation kind: ${def.kind}`);
  }
  if (!["daily", "weekdays", "weekly", "interval", "one-time", "advanced"].includes(def.cadence)) {
    throw new GuidedAutomationError(`unknown cadence: ${def.cadence}`);
  }
  if (def.kind === "scheduled-workflow" && !String(def.targetWorkflowId || "").trim()) {
    throw new GuidedAutomationError("scheduled-workflow requires a targetWorkflowId");
  }
  if (def.kind === "briefing" && !String(def.task || "").trim()) {
    throw new GuidedAutomationError("briefing requires a task/prompt");
  }
  if (def.cadence === "interval" && (!def.intervalMinutes || def.intervalMinutes < 1)) {
    throw new GuidedAutomationError("interval cadence requires intervalMinutes >= 1");
  }
  if (def.cadence === "interval" && !SUPPORTED_INTERVALS.has(Math.floor(Number(def.intervalMinutes)))) {
    throw new GuidedAutomationError("unsupported interval; choose a cadence that divides evenly into an hour or day");
  }
  if (def.time && !/^\d{2}:\d{2}$/.test(def.time)) {
    throw new GuidedAutomationError("time must be HH:MM");
  }
  const { h, m } = parseHM(def.time);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new GuidedAutomationError("time must be a valid 24-hour time");
  }
  const timezone = String(def.timezone || "UTC").trim() || "UTC";
  validateTimezone(timezone);
  if (def.cadence === "weekly" && (!Number.isInteger(def.weekday) || Number(def.weekday) < 0 || Number(def.weekday) > 6)) {
    throw new GuidedAutomationError("weekly cadence requires a weekday from 0 to 6");
  }
  if (def.cadence === "one-time") {
    const date = String(def.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GuidedAutomationError("one-time cadence requires a date");
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new GuidedAutomationError("one-time date is invalid");
    }
  }
  if (def.cadence === "advanced") validateCron(String(def.advancedCron || "").trim(), timezone);
  const deliveryChannel = def.deliveryChannel || "webchat";
  if (!["webchat", "telegram", "slack", "discord"].includes(deliveryChannel)) {
    throw new GuidedAutomationError(`unsupported delivery channel: ${deliveryChannel}`);
  }
  if (deliveryChannel !== "webchat" && !String(def.deliveryTarget || "").trim()) {
    throw new GuidedAutomationError(`${deliveryChannel} delivery requires a destination`);
  }
}

function deliveryConfig(def: GuidedAutomationDefinition): Record<string, unknown> {
  const channel = def.deliveryChannel || "webchat";
  const target = String(def.deliveryTarget || "").trim();
  if (channel === "telegram") return { to: target };
  if (channel === "slack") return { channel: target };
  if (channel === "discord") return { channelId: target };
  return {};
}

/** Build a normal workflow (generic nodes + cron-trigger) from a guided definition. */
export function buildGuidedAutomationWorkflow(def: GuidedAutomationDefinition): GuidedWorkflowDefinition {
  validateGuidedDefinition(def);
  const { expression, timezone } = cadenceToCron(def);
  const cronId = nanoid(8);
  const manualId = nanoid(8);
  const channelNode = CHANNEL_NODE[def.deliveryChannel || "webchat"] || "send-webchat";

  const nodes: RawNode[] = [
    n(cronId, "cron-trigger", 100, 120, { label: describeCadence(def), expression, timezone }),
    n(manualId, "manual-trigger", 100, 280, { label: "Run Now / Test" }),
  ];
  const edges: RawEdge[] = [];
  const description = def.purpose?.trim() || describeCadence(def);

  if (def.kind === "briefing") {
    const agentId = nanoid(8);
    const sendId = nanoid(8);
    nodes.push(
      n(agentId, "claude-agent", 380, 200, {
        label: "Compose Report",
        agentId: def.agentId || undefined,
        systemPrompt: def.task,
        temperature: 0.4,
        maxTokens: 1400,
      }),
      n(sendId, channelNode, 660, 200, { label: "Deliver", message: "{{agent.response}}", format: "markdown", ...deliveryConfig(def) }),
    );
    edges.push(e(cronId, agentId), e(manualId, agentId), e(agentId, sendId));
  } else if (def.kind === "scheduled-workflow") {
    const callId = nanoid(8);
    nodes.push(n(callId, "call-workflow", 380, 200, { label: "Run Workflow", workflowId: def.targetWorkflowId }));
    edges.push(e(cronId, callId), e(manualId, callId));
  } else {
    // health-check with alert-on-change
    const specId = nanoid(8);
    const codeId = nanoid(8);
    const gateId = nanoid(8);
    const alertId = nanoid(8);
    const okId = nanoid(8);
    nodes.push(
      n(specId, "system-command", 380, 200, { label: "Collect System Metrics", command: "pc-specs", action: "pc-specs" }),
      n(codeId, "run-code", 620, 200, {
        label: "Evaluate Thresholds",
        timeout: 5000,
        code:
          "var s=(input&&input.pcSpecs)||{};var d=s.disk||{};var warn=[];var free=Number(d.freePercent||100);if(isFinite(free)&&free<15)warn.push('Low disk: '+free.toFixed(1)+'% free');var rt=Number(s.ramTotalBytes||0),ru=Number(s.ramUsedBytes||0);if(rt>0&&(ru/rt)*100>90)warn.push('High RAM usage');result={hasWarning:warn.length>0,summary:warn.length?warn.join('; '):'All systems healthy'};",
      }),
      n(gateId, "if-else", 860, 200, { label: "Has Warnings?", condition: "result_hasWarning == true" }),
      n(alertId, channelNode, 1100, 120, { label: "Send Alert", message: "Warning: {{run.result.summary}}", format: "markdown", ...deliveryConfig(def) }),
      n(okId, "set-variables", 1100, 300, { label: "Healthy — No Alert", assignments: [{ key: "ok", value: "true" }] }),
    );
    edges.push(
      e(cronId, specId),
      e(manualId, specId),
      e(specId, codeId),
      e(codeId, gateId),
      e(gateId, alertId, "true"),
      e(gateId, okId, "false"),
    );
  }

  return { name: def.title.trim(), description, nodes, edges };
}
