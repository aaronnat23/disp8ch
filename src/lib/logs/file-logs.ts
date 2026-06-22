import fs from "node:fs";
import path from "node:path";

export type UiLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type UiLogEntry = {
  raw: string;
  time: string | null;
  level: UiLogLevel | null;
  subsystem: string | null;
  message: string;
};

const LEVELS = new Set<UiLogLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

const PLAIN_LINE_RE =
  /^\[([^\]]+)\]\s+\[([A-Za-z]+)\](?:\s+\[([^\]]+)\])?\s*(.*)$/;

function normalizeLevel(value: string | null | undefined): UiLogLevel | null {
  if (!value) return null;
  const lowered = value.trim().toLowerCase() as UiLogLevel;
  return LEVELS.has(lowered) ? lowered : null;
}

function parseJsonLogLine(line: string): UiLogEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const meta =
      parsed && typeof parsed._meta === "object" && parsed._meta
        ? (parsed._meta as Record<string, unknown>)
        : null;

    const time =
      typeof parsed.time === "string"
        ? parsed.time
        : typeof meta?.date === "string"
          ? meta.date
          : null;

    const level = normalizeLevel(
      typeof meta?.logLevelName === "string"
        ? meta.logLevelName
        : typeof meta?.level === "string"
          ? meta.level
          : null,
    );

    const subsystem =
      typeof parsed["0"] === "string"
        ? parsed["0"]
        : typeof meta?.name === "string"
          ? meta.name
          : null;

    let message = "";
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^\d+$/.test(key)) continue;
      if (typeof value === "string") {
        message += `${message ? " " : ""}${value}`;
      } else if (value != null) {
        message += `${message ? " " : ""}${JSON.stringify(value)}`;
      }
    }
    if (!message && typeof parsed.message === "string") {
      message = parsed.message;
    }

    return {
      raw: line,
      time,
      level,
      subsystem: subsystem && subsystem.length < 160 ? subsystem : null,
      message: message || line,
    };
  } catch {
    return null;
  }
}

export function parseLogLine(line: string): UiLogEntry {
  const trimmed = line.trim();
  if (!trimmed) {
    return { raw: line, time: null, level: null, subsystem: null, message: "" };
  }

  const jsonParsed = parseJsonLogLine(trimmed);
  if (jsonParsed) return jsonParsed;

  const plain = trimmed.match(PLAIN_LINE_RE);
  if (!plain) {
    return { raw: line, time: null, level: null, subsystem: null, message: trimmed };
  }

  return {
    raw: line,
    time: plain[1] ?? null,
    level: normalizeLevel(plain[2] ?? null),
    subsystem: plain[3] ?? null,
    message: (plain[4] || "").trim() || trimmed,
  };
}

export function getLogDirectory(): string {
  return path.join(process.cwd(), "data", "logs");
}

export function listLogFiles(): string[] {
  const dir = getLogDirectory();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .sort((a, b) => b.localeCompare(a));
}

export function tailLogFile(params: {
  fileName: string;
  maxBytes: number;
}): { text: string; truncated: boolean; absolutePath: string } {
  const safeName = path.basename(params.fileName);
  const filePath = path.join(getLogDirectory(), safeName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Log file not found: ${safeName}`);
  }

  const stats = fs.statSync(filePath);
  const maxBytes = Math.max(32 * 1024, Math.min(5 * 1024 * 1024, Math.floor(params.maxBytes)));
  const size = stats.size;
  const start = Math.max(0, size - maxBytes);

  const fd = fs.openSync(filePath, "r");
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    let truncated = start > 0;

    if (truncated) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      }
    }

    return {
      text,
      truncated,
      absolutePath: filePath,
    };
  } finally {
    fs.closeSync(fd);
  }
}
