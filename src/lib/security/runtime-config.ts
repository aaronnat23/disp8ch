import { getSqlite, initializeDatabase } from "@/lib/db";

export type InstallPosture = "local_only" | "trusted_lan" | "exposed";

export type SecurityRuntimeConfig = {
  installPosture: InstallPosture;
  disableLoopbackBypass: boolean;
  operatorAuthBackoffEnabled: boolean;
};

const DEFAULT_SECURITY_RUNTIME_CONFIG: SecurityRuntimeConfig = {
  installPosture: "local_only",
  disableLoopbackBypass: false,
  operatorAuthBackoffEnabled: true,
};

export function getSecurityRuntimeConfig(): SecurityRuntimeConfig {
  try {
    initializeDatabase();
    const row = getSqlite()
      .prepare(
        `SELECT install_posture, disable_loopback_bypass, operator_auth_backoff_enabled
           FROM app_config
          WHERE id = 'default'`,
      )
      .get() as {
        install_posture?: string | null;
        disable_loopback_bypass?: number | null;
        operator_auth_backoff_enabled?: number | null;
      } | undefined;

    const postureRaw = String(row?.install_posture || DEFAULT_SECURITY_RUNTIME_CONFIG.installPosture)
      .trim()
      .toLowerCase();
    const installPosture: InstallPosture =
      postureRaw === "trusted_lan" || postureRaw === "exposed" || postureRaw === "local_only"
        ? postureRaw
        : DEFAULT_SECURITY_RUNTIME_CONFIG.installPosture;

    return {
      installPosture,
      disableLoopbackBypass: Number(row?.disable_loopback_bypass || 0) === 1,
      operatorAuthBackoffEnabled: Number(row?.operator_auth_backoff_enabled ?? 1) !== 0,
    };
  } catch {
    return { ...DEFAULT_SECURITY_RUNTIME_CONFIG };
  }
}
