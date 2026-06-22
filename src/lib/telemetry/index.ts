import fs from "node:fs";
import path from "node:path";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("telemetry");

const TELEMETRY_PATH = process.env.TELEMETRY_PATH || "./data/telemetry/events.jsonl";

export interface TelemetryEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

function ensureTelemetryDir(): void {
  const filePath = path.resolve(TELEMETRY_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isTelemetryEnabled(): boolean {
  try {
    const db = getSqlite();
    const row = db.prepare("SELECT telemetry_enabled FROM app_config WHERE id = 'default'").get() as
      | { telemetry_enabled?: number | null }
      | undefined;
    return (row?.telemetry_enabled ?? 1) !== 0;
  } catch {
    return true;
  }
}

export function recordTelemetryEvent(type: string, data: Record<string, unknown>): void {
  if (!isTelemetryEnabled()) return;
  try {
    ensureTelemetryDir();
    const filePath = path.resolve(TELEMETRY_PATH);
    const entry: TelemetryEvent = {
      ts: new Date().toISOString(),
      type,
      data,
    };
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (error) {
    log.warn("Failed to write telemetry event", { error: String(error), type });
  }
}

function parseLine(raw: string): TelemetryEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TelemetryEvent>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.ts !== "string" || typeof parsed.type !== "string") return null;
    const data =
      parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? parsed.data as Record<string, unknown>
        : {};
    return { ts: parsed.ts, type: parsed.type, data };
  } catch {
    return null;
  }
}

export function readTelemetryRecent(limit = 100): TelemetryEvent[] {
  const filePath = path.resolve(TELEMETRY_PATH);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const selected = lines.slice(-Math.max(1, limit));
  const events: TelemetryEvent[] = [];
  for (const line of selected) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

export function readTelemetryStats(hours = 24): {
  totalEvents: number;
  windowHours: number;
  fromTs: string;
  byType: Record<string, number>;
} {
  const filePath = path.resolve(TELEMETRY_PATH);
  const now = Date.now();
  const from = now - Math.max(1, Math.floor(hours)) * 60 * 60 * 1000;
  const byType: Record<string, number> = {};
  let totalEvents = 0;

  if (!fs.existsSync(filePath)) {
    return {
      totalEvents: 0,
      windowHours: Math.max(1, Math.floor(hours)),
      fromTs: new Date(from).toISOString(),
      byType,
    };
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  // Keep stats scan bounded for very large logs.
  const scanLines = lines.slice(-50000);

  for (const raw of scanLines) {
    const entry = parseLine(raw);
    if (!entry) continue;
    const ts = new Date(entry.ts).getTime();
    if (!Number.isFinite(ts) || ts < from) continue;
    totalEvents += 1;
    byType[entry.type] = (byType[entry.type] || 0) + 1;
  }

  return {
    totalEvents,
    windowHours: Math.max(1, Math.floor(hours)),
    fromTs: new Date(from).toISOString(),
    byType,
  };
}
