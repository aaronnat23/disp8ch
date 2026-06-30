/**
 * Computer-use doctor report parsing. Normalizes a driver's raw doctor output
 * (or a missing-driver state) into a truthful report. Never fakes a pass: an
 * unparseable or missing driver yields `missing`/`failed`, not `pass`.
 */
import type { ComputerUseDoctorCheck, ComputerUseDoctorReport, ComputerUseDoctorStatus } from "./types";

function normalizeStatus(value: unknown): "pass" | "warn" | "fail" {
  const s = String(value || "").toLowerCase();
  if (s === "pass" || s === "ok" || s === "true" || s === "skip" || s === "skipped" || s === "n/a" || s === "not_applicable") return "pass";
  if (s === "warn" || s === "degraded" || s === "warning") return "warn";
  return "fail";
}

/**
 * Unwrap the result of a Cua MCP `call <tool>` invocation. The driver's MCP
 * surface returns tool results as `{ content: [{ type: "text", text }] }`,
 * `{ structuredContent: {...} }`, or `{ result: {...} }` depending on version.
 * Returns the inner object (parsing embedded JSON text when present) so the same
 * `parseDoctorReport` normalizer can classify it. Returns null when no usable
 * payload is found so the caller can fall back to the direct CLI doctor.
 */
export function unwrapMcpCallResult(raw: unknown): unknown {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return unwrapMcpCallResult(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // MCP tool-result text content: { content: [{ type: "text", text: "<json>" }] }
  if (Array.isArray(obj.content)) {
    for (const part of obj.content as Array<Record<string, unknown>>) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        const inner = unwrapMcpCallResult(part.text);
        if (inner && typeof inner === "object") return inner;
      }
    }
  }
  if (obj.structuredContent && typeof obj.structuredContent === "object") return obj.structuredContent;
  if (obj.result && typeof obj.result === "object") return obj.result;
  // Already a usable doctor-shaped object.
  if (Array.isArray(obj.checks) || Array.isArray(obj.probes) || "ok" in obj || "status" in obj) return obj;
  // A flat record of named checks is also usable.
  if (Object.keys(obj).length > 0) return obj;
  return null;
}

export function buildMissingDriverReport(reason = "Cua driver not found"): ComputerUseDoctorReport {
  return {
    overall: "missing",
    driver: null,
    checks: [{ name: "driver", status: "fail", detail: reason }],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Parse a raw doctor object (already JSON-decoded) into a normalized report.
 * Accepts shapes like { checks: [{name,status,detail}], driver, status } or a
 * flat record of boolean checks.
 */
export function parseDoctorReport(raw: unknown, driver: string | null = null): ComputerUseDoctorReport {
  if (!raw || typeof raw !== "object") {
    return buildMissingDriverReport("No doctor output");
  }
  const obj = raw as Record<string, unknown>;
  let checks: ComputerUseDoctorCheck[] = [];

  if (Array.isArray(obj.checks) || Array.isArray(obj.probes)) {
    const rawChecks = (Array.isArray(obj.checks) ? obj.checks : obj.probes) as Array<Record<string, unknown>>;
    checks = rawChecks.map((c) => ({
      name: String(c.name || c.label || "check"),
      status: normalizeStatus(c.status ?? c.ok),
      detail: String(c.detail || c.message || ""),
    }));
  } else {
    // Flat record of name -> boolean/string.
    for (const [name, value] of Object.entries(obj)) {
      if (name === "status" || name === "driver" || name === "overall") continue;
      checks.push({ name, status: normalizeStatus(value), detail: String(value) });
    }
  }

  if (checks.length === 0) {
    return buildMissingDriverReport("Doctor output had no checks");
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  let overall: ComputerUseDoctorStatus = "pass";
  if (hasFail) overall = "failed";
  else if (hasWarn) overall = "degraded";

  const explicitStatus = String(obj.overall ?? obj.status ?? "").toLowerCase();
  if (/fail|failed|error|blocked/.test(explicitStatus)) overall = "failed";
  else if (overall !== "failed" && /degraded|warn|warning/.test(explicitStatus)) overall = "degraded";

  return {
    overall,
    driver: obj.driver ? String(obj.driver) : driver,
    checks,
    generatedAt: new Date().toISOString(),
  };
}
