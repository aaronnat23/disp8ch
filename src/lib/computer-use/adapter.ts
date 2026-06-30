/**
 * Computer-use adapter registry + capability state. Computer use is OFF by
 * default and stays disabled until the user explicitly enables it AND a working
 * driver passes doctor checks. `implemented` is true (the code exists);
 * `configured` requires an installed driver; `ready` requires enablement + a
 * passing (or explicitly accepted degraded) doctor report.
 */
import { CuaComputerUseAdapter } from "./cua-driver";
import type { ComputerUseAdapter } from "./types";

let cached: ComputerUseAdapter | null = null;
let capabilityCache: { key: string; expiresAt: number; value: ComputerUseCapability } | null = null;
const CAPABILITY_CACHE_TTL_MS = 30_000;

export function getComputerUseAdapter(): ComputerUseAdapter {
  if (!cached) cached = new CuaComputerUseAdapter();
  return cached;
}

export function computerUseEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.DISP8CH_ENABLE_COMPUTER_USE || "").trim());
}

export type ComputerUseCapability = {
  implemented: boolean;
  configured: boolean;
  ready: boolean;
  enabled: boolean;
  installed: boolean;
  doctorStatus: string;
  reason: string;
};

export function invalidateComputerUseCapabilityCache(): void {
  capabilityCache = null;
}

export async function getComputerUseCapability(options: { force?: boolean } = {}): Promise<ComputerUseCapability> {
  const adapter = getComputerUseAdapter();
  const enabled = computerUseEnabled();
  const cacheKey = `${enabled}:${process.env.DISP8CH_CUA_DRIVER_CMD || ""}`;
  if (!options.force && capabilityCache?.key === cacheKey && capabilityCache.expiresAt > Date.now()) {
    return capabilityCache.value;
  }
  let installed = false;
  let doctorStatus = "missing";
  try {
    const state = await adapter.isInstalled();
    installed = state.installed;
    if (installed) {
      const report = await adapter.doctor();
      doctorStatus = report.overall;
    }
  } catch {
    installed = false;
  }

  const configured = installed;
  const ready = enabled && configured && (doctorStatus === "pass" || doctorStatus === "degraded");

  let reason: string;
  if (!enabled) {
    reason = "Computer use is disabled. Enable it in Settings → Computer Use (beta) to use it.";
  } else if (!installed) {
    reason = "Computer use is enabled but no Cua driver is installed. Install cua-driver, then run doctor.";
  } else if (doctorStatus === "failed") {
    reason = "Cua driver is installed but doctor checks failed. Resolve the failing checks.";
  } else if (doctorStatus === "degraded") {
    reason = "Cua driver works in a degraded state. Computer use is available with limitations.";
  } else {
    reason = "Computer use is enabled, installed, and passing doctor checks.";
  }

  const value = {
    implemented: true,
    configured,
    ready,
    enabled,
    installed,
    doctorStatus,
    reason,
  };
  capabilityCache = { key: cacheKey, expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS, value };
  return value;
}
