import fs from "node:fs";
import path from "node:path";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getConfiguredAcpAuthMode, isAcpAuthConfigured } from "@/lib/acp/auth";
import { getConfiguredIngressProvenanceMode } from "@/lib/provenance";
import { getSecretsStatus, listSecretsMeta } from "@/lib/secrets/store";
import { getConfiguredAllowedOriginHostnames } from "@/lib/security/origin";
import { getSecurityRuntimeConfig } from "@/lib/security/runtime-config";
import { getWebsitePolicy } from "@/lib/security/website-policy";
import { normalizeMCPServerConfig } from "@/lib/mcp/client";
import { resolveNodeEffect } from "@/lib/engine/effects";
import { normalizeMemoryAccess } from "@/lib/memory/workflow-scope";
import { getWorkflowApprovalPolicyOrNull } from "@/lib/engine/workflow-policy";

export type SecurityAuditStatus = "ok" | "warn" | "error";

export type SecurityAuditFinding = {
  id: string;
  title: string;
  status: SecurityAuditStatus;
  summary: string;
  details?: string[];
};

export type SecurityAuditArea = {
  id: string;
  title: string;
  description: string;
  status: SecurityAuditStatus;
  findings: SecurityAuditFinding[];
};

export type SecurityAuditSurfaceRoute = {
  path: string;
  mode: "public" | "mixed";
  purpose: string;
  exposure: string;
  stateChanging: boolean;
  safeguards: string[];
};

export type SecurityAuditReport = {
  ok: boolean;
  checkedAt: string;
  errors: number;
  warnings: number;
  summary: {
    totalRoutes: number;
    protectedRoutes: number;
    operatorRoutes: number;
    adminRoutes: number;
    mixedRoutes: number;
    publicRoutes: number;
    publicStateChangingRoutes: number;
    unexpectedPublicRoutes: number;
    adminTokenConfigured: boolean;
    wsAuthTokenConfigured: boolean;
    secretsEncrypted: boolean;
    teamsAllowlistConfigured: boolean;
    websitePolicyMode: "off" | "blocklist" | "allowlist";
    websitePolicyDomains: number;
    installPosture: "local_only" | "trusted_lan" | "exposed";
    loopbackBypassEnabled: boolean;
    operatorAuthBackoffEnabled: boolean;
  };
  areas: SecurityAuditArea[];
  publicRoutes: SecurityAuditSurfaceRoute[];
  mixedRoutes: SecurityAuditSurfaceRoute[];
  recommendations: string[];
};

type RouteMetadata = {
  mode: "public" | "mixed";
  purpose: string;
  exposure: string;
  stateChanging: boolean;
  safeguards: (context: RuntimeAuditContext) => string[];
};

type RuntimeAuditContext = {
  acpAuthMode: "off" | "bearer";
  acpAuthConfigured: boolean;
  provenanceMode: "off" | "meta" | "meta+receipt";
  teamsAllowlistConfigured: boolean;
};

type RouteInventory = {
  totalRoutes: number;
  protectedRoutes: number;
  operatorRoutes: number;
  adminRoutes: number;
  publicRoutes: SecurityAuditSurfaceRoute[];
  mixedRoutes: SecurityAuditSurfaceRoute[];
  unexpectedPublicRoutes: string[];
};

type ActiveAgentPolicySummary = {
  totalAgentNodes: number;
  allowlistAgents: number;
  denyAgents: number;
  fullAgents: number;
  fullNoApprovalAgents: number;
  humanApprovalAgents: number;
  modelApprovalAgents: number;
  riskyExamples: string[];
};

const STATUS_RANK: Record<SecurityAuditStatus, number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

const API_ROUTE_METADATA: Record<string, RouteMetadata> = {
  "/api/acp": {
    mode: "mixed",
    purpose: "ACP ingress and status surface",
    exposure: "ingress",
    stateChanging: true,
    safeguards: (context) => [
      "Capped request bodies",
      context.acpAuthMode === "bearer"
        ? context.acpAuthConfigured
          ? "Bearer auth enforced for ingress and session actions"
          : "Bearer auth mode enabled but token is not configured"
        : "ACP auth currently off",
      `Ingress provenance mode: ${context.provenanceMode}`,
    ],
  },
  "/api/auth/google/callback": {
    mode: "public",
    purpose: "Google OAuth callback",
    exposure: "oauth",
    stateChanging: true,
    safeguards: () => ["PKCE verifier cookie", "OAuth state validation", "Short-lived callback cookies"],
  },
  "/api/auth/google/login": {
    mode: "public",
    purpose: "Google OAuth login redirect",
    exposure: "oauth",
    stateChanging: true,
    safeguards: () => ["PKCE challenge generation", "OAuth state cookie", "Short-lived verifier cookie"],
  },
  "/api/auth/logout": {
    mode: "public",
    purpose: "Browser session logout",
    exposure: "session",
    stateChanging: true,
    safeguards: () => ["Only clears the current session cookie", "Cross-site browser writes blocked by middleware"],
  },
  "/api/auth/me": {
    mode: "public",
    purpose: "Session identity check",
    exposure: "read",
    stateChanging: false,
    safeguards: () => ["Returns 401 when no signed-in session exists"],
  },
  "/api/channels/google-chat": {
    mode: "public",
    purpose: "Google Chat inbound webhook",
    exposure: "ingress",
    stateChanging: true,
    safeguards: () => ["128KB body cap", "Plain-text normalization before routing"],
  },
  "/api/channels/teams": {
    mode: "public",
    purpose: "Microsoft Teams inbound webhook",
    exposure: "ingress",
    stateChanging: true,
    safeguards: (context) => [
      "128KB body cap",
      "HTTPS-only serviceUrl validation",
      context.teamsAllowlistConfigured
        ? "TEAMS_ALLOWED_SERVICE_HOSTS allowlist enforced"
        : "Private/local host blocks even without explicit allowlist",
    ],
  },
  "/api/health": {
    mode: "public",
    purpose: "Read-only health probe",
    exposure: "read",
    stateChanging: false,
    safeguards: () => ["Read-only status output"],
  },
  "/api/onboarding": {
    mode: "public",
    purpose: "First-run onboarding state",
    exposure: "setup",
    stateChanging: true,
    safeguards: () => ["Cross-site browser writes blocked by middleware", "Loopback-first deployment model"],
  },
  "/api/webhooks/[id]": {
    mode: "public",
    purpose: "Signed workflow webhook ingress",
    exposure: "ingress",
    stateChanging: true,
    safeguards: () => ["HMAC signature", "Timestamp freshness", "Replay nonce cache", "256KB body cap", "Per-IP rate limit"],
  },
};

function sourcePath(...parts: string[]) {
  return path.join(process.cwd(), ...parts);
}

function readSource(...parts: string[]): string {
  try {
    return fs.readFileSync(sourcePath(...parts), "utf8");
  } catch {
    return "";
  }
}

function statusFromFindings(findings: SecurityAuditFinding[]): SecurityAuditStatus {
  let worst: SecurityAuditStatus = "ok";
  for (const finding of findings) {
    if (STATUS_RANK[finding.status] > STATUS_RANK[worst]) {
      worst = finding.status;
    }
  }
  return worst;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readRawMcpServerEntries(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      : [];
  } catch {
    return [];
  }
}

function deriveApiPathFromRouteFile(filePath: string, apiRoot: string): string {
  const relative = path.relative(apiRoot, filePath).replace(/\\/g, "/");
  if (relative === "route.ts") return "/api";
  return `/api/${relative.replace(/\/route\.ts$/, "")}`;
}

function listApiRouteFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listApiRouteFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

function buildRouteInventory(context: RuntimeAuditContext): RouteInventory {
  const apiRoot = sourcePath("src", "app", "api");
  const routeFiles = listApiRouteFiles(apiRoot);
  const publicRoutes: SecurityAuditSurfaceRoute[] = [];
  const mixedRoutes: SecurityAuditSurfaceRoute[] = [];
  const unexpectedPublicRoutes: string[] = [];
  let protectedRoutes = 0;
  let operatorRoutes = 0;
  let adminRoutes = 0;

  for (const filePath of routeFiles) {
    const routePath = deriveApiPathFromRouteFile(filePath, apiRoot);
    const src = fs.readFileSync(filePath, "utf8");
    if (src.includes("requireAdminAccess")) {
      protectedRoutes += 1;
      adminRoutes += 1;
      continue;
    }
    if (src.includes("requireOperatorAccess")) {
      protectedRoutes += 1;
      operatorRoutes += 1;
      continue;
    }
    const meta = API_ROUTE_METADATA[routePath];
    if (!meta) {
      unexpectedPublicRoutes.push(routePath);
      continue;
    }
    const route: SecurityAuditSurfaceRoute = {
      path: routePath,
      mode: meta.mode,
      purpose: meta.purpose,
      exposure: meta.exposure,
      stateChanging: meta.stateChanging,
      safeguards: meta.safeguards(context),
    };
    if (meta.mode === "mixed") {
      mixedRoutes.push(route);
    } else {
      publicRoutes.push(route);
    }
  }

  publicRoutes.sort((a, b) => a.path.localeCompare(b.path));
  mixedRoutes.sort((a, b) => a.path.localeCompare(b.path));
  unexpectedPublicRoutes.sort((a, b) => a.localeCompare(b));

  return {
    totalRoutes: routeFiles.length,
    protectedRoutes,
    operatorRoutes,
    adminRoutes,
    publicRoutes,
    mixedRoutes,
    unexpectedPublicRoutes,
  };
}

function summarizeActiveAgentPolicies(): ActiveAgentPolicySummary {
  initializeDatabase();
  const db = getSqlite();
  const workflowRows = db.prepare("SELECT id, name, nodes FROM workflows WHERE is_active = 1").all() as Array<{
    id: string;
    name: string;
    nodes: string;
  }>;

  const summary: ActiveAgentPolicySummary = {
    totalAgentNodes: 0,
    allowlistAgents: 0,
    denyAgents: 0,
    fullAgents: 0,
    fullNoApprovalAgents: 0,
    humanApprovalAgents: 0,
    modelApprovalAgents: 0,
    riskyExamples: [],
  };

  for (const workflow of workflowRows) {
    let parsedNodes: unknown;
    try {
      parsedNodes = JSON.parse(workflow.nodes);
    } catch {
      continue;
    }
    if (!Array.isArray(parsedNodes)) continue;

    for (const node of parsedNodes) {
      if (!isObject(node) || node.type !== "claude-agent") continue;
      const data = isObject(node.data) ? node.data : {};
      const execSecurity = String(data.execSecurity || "full").trim().toLowerCase();
      const approvalMode = String(data.approvalMode || "off").trim().toLowerCase();
      summary.totalAgentNodes += 1;
      if (execSecurity === "allowlist") summary.allowlistAgents += 1;
      else if (execSecurity === "deny") summary.denyAgents += 1;
      else summary.fullAgents += 1;
      if (approvalMode === "human") summary.humanApprovalAgents += 1;
      else if (approvalMode === "model") summary.modelApprovalAgents += 1;
      if (execSecurity === "full" && approvalMode === "off") {
        summary.fullNoApprovalAgents += 1;
        if (summary.riskyExamples.length < 5) {
          summary.riskyExamples.push(`${workflow.name || workflow.id} · ${String(node.id || "agent")}`);
        }
      }
    }
  }

  return summary;
}

type WorkflowEffectRiskSummary = {
  unknownEffectNodes: string[];
  legacyMemoryNodes: string[];
  unattendedExternalSends: string[];
};

const TRIGGER_TYPES_BY_NODE: Record<string, "manual" | "cron" | "webhook" | "message"> = {
  "cron-trigger": "cron",
  "webhook-trigger": "webhook",
  "github-trigger": "webhook",
  "message-trigger": "message",
  "telegram-trigger": "message",
  "discord-trigger": "message",
};
const MEMORY_NODE_TYPES = new Set(["memory-recall", "memory-store", "claude-agent"]);

/**
 * Scans active workflows for the workflow-effect/memory-scope concerns raised by
 * the approval+memory work: unknown effects on active nodes, legacy implicit
 * agent-wide memory, and external sends that can run unattended without an
 * explicit approval policy.
 */
function summarizeWorkflowEffectRisks(): WorkflowEffectRiskSummary {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare("SELECT id, name, nodes FROM workflows WHERE is_active = 1").all() as Array<{ id: string; name: string; nodes: string }>;
  const summary: WorkflowEffectRiskSummary = { unknownEffectNodes: [], legacyMemoryNodes: [], unattendedExternalSends: [] };

  for (const wf of rows) {
    let nodes: unknown;
    try { nodes = JSON.parse(wf.nodes); } catch { continue; }
    if (!Array.isArray(nodes)) continue;
    const hasApprovalPolicy = Boolean(getWorkflowApprovalPolicyOrNull(wf.id));
    const isUnattended = nodes.some((n) => isObject(n) && typeof n.type === "string" && TRIGGER_TYPES_BY_NODE[n.type] && TRIGGER_TYPES_BY_NODE[n.type] !== "manual");
    const label = wf.name || wf.id;

    for (const node of nodes) {
      if (!isObject(node) || typeof node.type !== "string") continue;
      const data = isObject(node.data) ? node.data : {};
      const effect = resolveNodeEffect(node.type, data);
      if (effect.kind === "unknown" && summary.unknownEffectNodes.length < 10) {
        summary.unknownEffectNodes.push(`${label} · ${String(node.id || node.type)} (${node.type})`);
      }
      if (MEMORY_NODE_TYPES.has(node.type)) {
        const access = normalizeMemoryAccess(data.memoryAccess, "agent");
        if (access === "agent" && summary.legacyMemoryNodes.length < 10) {
          summary.legacyMemoryNodes.push(`${label} · ${String(node.id || node.type)} (${node.type})`);
        }
      }
      if ((effect.kind === "external_send" || effect.kind === "external_write") && isUnattended && !hasApprovalPolicy && summary.unattendedExternalSends.length < 10) {
        summary.unattendedExternalSends.push(`${label} · ${String(node.id || node.type)} (${node.type})`);
      }
    }
  }
  return summary;
}

export function runSecurityAudit(): SecurityAuditReport {
  initializeDatabase();
  const db = getSqlite();

  const secretsStatus = getSecretsStatus();
  const secrets = listSecretsMeta();
  const adminTokenConfigured = Boolean(String(process.env.DISP8CH_ADMIN_TOKEN || "").trim());
  const wsAuthTokenConfigured = Boolean(String(process.env.WS_AUTH_TOKEN || "").trim());
  const teamsAllowedHosts = normalizeList(String(process.env.TEAMS_ALLOWED_SERVICE_HOSTS || ""));
  const teamsAllowlistConfigured = teamsAllowedHosts.length > 0;
  const allowedOrigins = [...getConfiguredAllowedOriginHostnames()].sort();
  const trustProxyEnabled = /^(1|true|yes|on)$/i.test(String(process.env.DISP8CH_TRUST_PROXY || "").trim());
  const websitePolicy = getWebsitePolicy();
  const provenanceMode = getConfiguredIngressProvenanceMode();
  const acpAuthMode = getConfiguredAcpAuthMode();
  const acpAuthConfigured = isAcpAuthConfigured();
  const securityRuntime = getSecurityRuntimeConfig();
  const appConfigRow = db.prepare("SELECT mcp_servers FROM app_config WHERE id = 'default'").get() as { mcp_servers?: string | null } | undefined;
  const rawMcpEntries = readRawMcpServerEntries(appConfigRow?.mcp_servers);
  const mcpConfigs = rawMcpEntries
    .map((entry) => ({ raw: entry, normalized: normalizeMCPServerConfig(entry) }))
    .filter((entry): entry is { raw: Record<string, unknown>; normalized: NonNullable<ReturnType<typeof normalizeMCPServerConfig>> } => Boolean(entry.normalized));
  const routeInventory = buildRouteInventory({
    acpAuthMode,
    acpAuthConfigured,
    provenanceMode,
    teamsAllowlistConfigured,
  });
  const publicStateChangingRoutes = routeInventory.publicRoutes.filter((route) => route.stateChanging).length;
  const activeAgentPolicies = summarizeActiveAgentPolicies();

  const webhookRows = db.prepare("SELECT id, name, secret, is_active FROM webhooks WHERE is_active = 1").all() as Array<{
    id: string;
    name: string;
    secret: string;
    is_active: number;
  }>;
  const weakWebhooks = webhookRows.filter((row) => String(row.secret || "").trim().length < 24);

  const middlewareSrc = readSource("src", "middleware.ts");
  const googleChatSrc = readSource("src", "app", "api", "channels", "google-chat", "route.ts");
  const teamsSrc = readSource("src", "app", "api", "channels", "teams", "route.ts");
  const webhooksSrc = readSource("src", "app", "api", "webhooks", "[id]", "route.ts");
  const toolsSrc = readSource("src", "lib", "engine", "tools.ts");
  const hostEnvSrc = readSource("src", "lib", "security", "host-env.ts");

  const accessFindings: SecurityAuditFinding[] = [];
  accessFindings.push(
    adminTokenConfigured
      ? {
          id: "admin-token",
          title: "Admin token",
          status: "ok",
          summary: "DISP8CH_ADMIN_TOKEN is configured for explicit operator/admin access.",
        }
      : {
          id: "admin-token",
          title: "Admin token",
          status: "warn",
          summary: "No DISP8CH_ADMIN_TOKEN is configured; operator/admin APIs still allow loopback access when no token exists.",
          details: ["Set DISP8CH_ADMIN_TOKEN before exposing the app beyond localhost."],
        },
  );
  accessFindings.push(
    securityRuntime.installPosture === "exposed" && !adminTokenConfigured
      ? {
          id: "install-posture",
          title: "Install posture",
          status: "error",
          summary: "Install posture is set to exposed but DISP8CH_ADMIN_TOKEN is not configured.",
          details: ["Set DISP8CH_ADMIN_TOKEN before using install_posture=exposed."],
        }
      : {
          id: "install-posture",
          title: "Install posture",
          status: securityRuntime.installPosture === "local_only" ? "ok" : "warn",
          summary: `Install posture is ${securityRuntime.installPosture}.`,
          details:
            securityRuntime.installPosture === "local_only"
              ? undefined
              : ["Confirm reverse proxy, origin policy, and operator token posture match the deployment."],
        },
  );
  accessFindings.push(
    securityRuntime.disableLoopbackBypass
      ? {
          id: "loopback-bypass",
          title: "Loopback bypass",
          status: "ok",
          summary: "Loopback operator/admin bypass is disabled after onboarding.",
        }
      : {
          id: "loopback-bypass",
          title: "Loopback bypass",
          status: adminTokenConfigured ? "warn" : "ok",
          summary: adminTokenConfigured
            ? "Loopback operator/admin bypass is still enabled when no session or token is supplied."
            : "Loopback bypass is available only while no admin token is configured.",
          details: ["Set disable_loopback_bypass=1 after local bootstrap if you want token-or-session auth everywhere."],
        },
  );
  accessFindings.push(
    securityRuntime.operatorAuthBackoffEnabled
      ? {
          id: "auth-backoff",
          title: "Operator auth backoff",
          status: "ok",
          summary: "Failed operator/admin auth attempts trigger in-process backoff.",
        }
      : {
          id: "auth-backoff",
          title: "Operator auth backoff",
          status: "warn",
          summary: "Operator/admin auth backoff is disabled.",
          details: ["Enable operator_auth_backoff_enabled to slow repeated failed auth attempts on protected routes."],
        },
  );
  accessFindings.push(
    routeInventory.unexpectedPublicRoutes.length > 0
      ? {
          id: "route-inventory",
          title: "API route inventory",
          status: "error",
          summary: `${routeInventory.unexpectedPublicRoutes.length} API route(s) are publicly reachable without a documented security classification.`,
          details: routeInventory.unexpectedPublicRoutes,
        }
      : {
          id: "route-inventory",
          title: "API route inventory",
          status: "ok",
          summary: `${routeInventory.protectedRoutes} protected route file(s), ${routeInventory.publicRoutes.length} intentional public route(s), ${routeInventory.mixedRoutes.length} mixed-access route(s).`,
          details: routeInventory.mixedRoutes.length > 0 ? routeInventory.mixedRoutes.map((route) => route.path) : undefined,
        },
  );

  const secretAndAuthFindings: SecurityAuditFinding[] = [];
  secretAndAuthFindings.push(
    secretsStatus.masterKeyConfigured
      ? {
          id: "secrets-master-key",
          title: "Secrets encryption",
          status: "ok",
          summary: `Encrypted secrets storage is active for ${secrets.length} stored secret(s).`,
          details: secretsStatus.keySource ? [`Key source: ${secretsStatus.keySource}`] : undefined,
        }
      : {
          id: "secrets-master-key",
          title: "Secrets encryption",
          status: secrets.length > 0 ? "error" : "warn",
          summary: secrets.length > 0
            ? "Secrets exist but no master key is configured."
            : "No master key is configured for encrypted secret storage.",
          details: ["Set ENCRYPTION_KEY or SECRETS_MASTER_KEY."],
        },
  );
  secretAndAuthFindings.push(
    wsAuthTokenConfigured
      ? {
          id: "ws-auth",
          title: "WebSocket auth token",
          status: "ok",
          summary: "WS_AUTH_TOKEN is configured for non-session WebSocket clients.",
        }
      : {
          id: "ws-auth",
          title: "WebSocket auth token",
          status: "warn",
          summary: "WebSockets rely on session or loopback trust only.",
          details: ["Set WS_AUTH_TOKEN if you expose the app or WS endpoint outside a trusted local browser session."],
        },
  );
  if (acpAuthMode === "bearer" && acpAuthConfigured) {
    secretAndAuthFindings.push({
      id: "acp-auth",
      title: "ACP ingress auth",
      status: "ok",
      summary: "ACP bearer auth is enabled and configured.",
    });
  } else if (acpAuthMode === "bearer") {
    secretAndAuthFindings.push({
      id: "acp-auth",
      title: "ACP ingress auth",
      status: "error",
      summary: "ACP bearer mode is enabled but no bearer token is currently resolvable.",
      details: ["Set ACP_INGRESS_TOKEN or configure acp_auth_secret_name to a stored secret."],
    });
  } else {
    secretAndAuthFindings.push({
      id: "acp-auth",
      title: "ACP ingress auth",
      status: "warn",
      summary: "ACP auth mode is off.",
      details: ["Enable ACP bearer auth before exposing /api/acp to external clients."],
    });
  }

  const browserNetworkFindings: SecurityAuditFinding[] = [];
  const securityHeadersPresent = [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "X-Frame-Options",
    "X-Content-Type-Options",
  ].every((header) => middlewareSrc.includes(header));
  const crossSiteWriteRejectionPresent = middlewareSrc.includes("Cross-site browser write rejected");
  browserNetworkFindings.push(
    securityHeadersPresent && crossSiteWriteRejectionPresent
      ? {
          id: "browser-guards",
          title: "Browser-side guards",
          status: "ok",
          summary: "Middleware enforces security headers and rejects cross-site browser writes.",
        }
      : {
          id: "browser-guards",
          title: "Browser-side guards",
          status: "error",
          summary: "Middleware is missing either security headers or cross-site browser write rejection.",
        },
  );
  browserNetworkFindings.push(
    allowedOrigins.length <= 1
      ? {
          id: "allowed-origins",
          title: "Allowed browser origins",
          status: "ok",
          summary: "Only localhost is trusted for browser/WebSocket origin checks.",
        }
      : {
          id: "allowed-origins",
          title: "Allowed browser origins",
          status: "warn",
          summary: `${allowedOrigins.length - 1} extra trusted origin hostname(s) are configured.`,
          details: allowedOrigins.filter((host) => host !== "localhost"),
        },
  );
  browserNetworkFindings.push(
    trustProxyEnabled
      ? {
          id: "trust-proxy",
          title: "Proxy trust",
          status: "warn",
          summary: "DISP8CH_TRUST_PROXY is enabled, so forwarded IP headers are trusted globally.",
          details: ["Prefer keeping this off unless the app sits behind a fixed trusted proxy layer."],
        }
      : {
          id: "trust-proxy",
          title: "Proxy trust",
          status: "ok",
          summary: "Forwarded IP headers are not trusted unless explicitly enabled.",
        },
  );
  browserNetworkFindings.push(
    websitePolicy.mode === "blocklist" || websitePolicy.mode === "allowlist"
      ? {
          id: "website-policy",
          title: "Website policy",
          status: "ok",
          summary: `Website ${websitePolicy.mode} mode is active for ${websitePolicy.domains.length} domain(s).`,
          details: websitePolicy.domains.length > 0 ? websitePolicy.domains : undefined,
        }
      : {
          id: "website-policy",
          title: "Website policy",
          status: "warn",
          summary: "No domain blocklist is active for browser, HTTP, scrape, or targeted search tools.",
          details: ["Use website_policy_mode=blocklist when you want the runtime to refuse specific domains."],
        },
  );

  const ingressFindings: SecurityAuditFinding[] = [];
  ingressFindings.push(
    weakWebhooks.length > 0
      ? {
          id: "webhook-signing",
          title: "Webhook signing and replay defense",
          status: "error",
          summary: `${weakWebhooks.length} active webhook(s) have weak shared secrets.`,
          details: weakWebhooks.map((row) => `${row.id} (${row.name})`),
        }
      : {
          id: "webhook-signing",
          title: "Webhook signing and replay defense",
          status: "ok",
          summary: webhookRows.length > 0
            ? `${webhookRows.length} active webhook(s) use signed ingress with replay protection.`
            : "No active public workflow webhooks are configured.",
        },
  );
  ingressFindings.push(
    teamsAllowlistConfigured
      ? {
          id: "teams-allowlist",
          title: "Teams callback allowlist",
          status: "ok",
          summary: `TEAMS_ALLOWED_SERVICE_HOSTS is configured with ${teamsAllowedHosts.length} host(s).`,
        }
      : {
          id: "teams-allowlist",
          title: "Teams callback allowlist",
          status: "warn",
          summary: "Teams inbound callbacks block local/private hosts, but TEAMS_ALLOWED_SERVICE_HOSTS is not configured.",
          details: ["Set TEAMS_ALLOWED_SERVICE_HOSTS when enabling Teams in less-trusted environments."],
        },
  );
  const channelBodyCapsPresent =
    googleChatSrc.includes("readCappedJson") &&
    teamsSrc.includes("readCappedJson") &&
    webhooksSrc.includes("readCappedText");
  ingressFindings.push(
    channelBodyCapsPresent
      ? {
          id: "body-caps",
          title: "Ingress body caps",
          status: "ok",
          summary: "Webhook, Google Chat, and Teams ingress routes enforce body-size caps.",
        }
      : {
          id: "body-caps",
          title: "Ingress body caps",
          status: "error",
          summary: "One or more public ingress routes are missing capped body reads.",
        },
  );
  ingressFindings.push(
    provenanceMode === "off"
      ? {
          id: "provenance-mode",
          title: "Ingress provenance",
          status: "warn",
          summary: "Ingress provenance is off, so external message tracing is reduced.",
          details: ["Use provenance_mode=meta or meta+receipt for better auditability."],
        }
      : provenanceMode === "meta+receipt"
        ? {
            id: "provenance-mode",
            title: "Ingress provenance",
            status: "ok",
            summary: "Ingress provenance receipts are enabled for external inputs.",
          }
        : {
            id: "provenance-mode",
            title: "Ingress provenance",
            status: "ok",
            summary: "Ingress provenance metadata is enabled.",
            details: ["Switch to meta+receipt if you want user-visible receipts as well as stored metadata."],
          },
  );

  const executionFindings: SecurityAuditFinding[] = [];
  const execGuardsPresent =
    toolsSrc.includes("invisible-unicode") &&
    toolsSrc.includes('trimmed.includes("\\0")') &&
    toolsSrc.includes("Obfuscated/encoded command pattern detected");
  executionFindings.push(
    execGuardsPresent
      ? {
          id: "exec-guards",
          title: "Exec obfuscation guards",
          status: "ok",
          summary: "Command execution rejects null bytes and detects obfuscated or invisible-Unicode command content.",
        }
      : {
          id: "exec-guards",
          title: "Exec obfuscation guards",
          status: "error",
          summary: "Exec obfuscation or null-byte guards are missing from tool policy enforcement.",
        },
  );
  executionFindings.push(
    hostEnvSrc.includes("sanitizeHostExecEnv")
      ? {
          id: "host-env",
          title: "Host environment sanitization",
          status: "ok",
          summary: "Subprocess environments are sanitized before host execution.",
        }
      : {
          id: "host-env",
          title: "Host environment sanitization",
          status: "error",
          summary: "Host subprocess environment sanitization code is missing.",
        },
  );
  if (activeAgentPolicies.totalAgentNodes === 0) {
    executionFindings.push({
      id: "workflow-exec-policy",
      title: "Active workflow exec policy",
      status: "ok",
      summary: "No active agent nodes were found in workflows.",
    });
  } else if (activeAgentPolicies.fullNoApprovalAgents > 0) {
    executionFindings.push({
      id: "workflow-exec-policy",
      title: "Active workflow exec policy",
      status: "warn",
      summary: `${activeAgentPolicies.fullNoApprovalAgents} active agent node(s) use execSecurity=full with approvalMode=off.`,
      details: [
        `allowlist=${activeAgentPolicies.allowlistAgents}, full=${activeAgentPolicies.fullAgents}, deny=${activeAgentPolicies.denyAgents}`,
        `human approvals=${activeAgentPolicies.humanApprovalAgents}, model approvals=${activeAgentPolicies.modelApprovalAgents}`,
        ...activeAgentPolicies.riskyExamples,
      ],
    });
  } else {
    executionFindings.push({
      id: "workflow-exec-policy",
      title: "Active workflow exec policy",
      status: "ok",
      summary: `${activeAgentPolicies.totalAgentNodes} active agent node(s) found with no fully-open exec path running without approvals.`,
      details: [
        `allowlist=${activeAgentPolicies.allowlistAgents}, full=${activeAgentPolicies.fullAgents}, deny=${activeAgentPolicies.denyAgents}`,
        `human approvals=${activeAgentPolicies.humanApprovalAgents}, model approvals=${activeAgentPolicies.modelApprovalAgents}`,
      ],
    });
  }

  // Workflow effect + memory scope findings (approval & memory work).
  const workflowEffectRisks = summarizeWorkflowEffectRisks();
  executionFindings.push(
    workflowEffectRisks.unknownEffectNodes.length > 0
      ? {
          id: "workflow-unknown-effects",
          title: "Unknown-effect workflow nodes",
          status: "warn",
          summary: `${workflowEffectRisks.unknownEffectNodes.length} active node(s) have an unclassified effect and fail closed (blocked) at run time.`,
          details: workflowEffectRisks.unknownEffectNodes,
        }
      : {
          id: "workflow-unknown-effects",
          title: "Unknown-effect workflow nodes",
          status: "ok",
          summary: "Every active workflow node resolves to a known runtime effect.",
        },
  );
  executionFindings.push(
    workflowEffectRisks.legacyMemoryNodes.length > 0
      ? {
          id: "workflow-legacy-memory",
          title: "Legacy agent-wide workflow memory",
          status: "warn",
          summary: `${workflowEffectRisks.legacyMemoryNodes.length} active memory/agent node(s) use agent-wide memory shared across every workflow.`,
          details: [
            "Switch Memory access to \"This workflow\" to keep a workflow's memory private.",
            ...workflowEffectRisks.legacyMemoryNodes,
          ],
        }
      : {
          id: "workflow-legacy-memory",
          title: "Legacy agent-wide workflow memory",
          status: "ok",
          summary: "No active workflow node relies on implicit agent-wide memory.",
        },
  );
  executionFindings.push(
    workflowEffectRisks.unattendedExternalSends.length > 0
      ? {
          id: "workflow-unattended-sends",
          title: "Unattended external sends without an approval policy",
          status: "warn",
          summary: `${workflowEffectRisks.unattendedExternalSends.length} external send/write node(s) can run on an unattended trigger without an approval policy.`,
          details: [
            "Set an approval policy (balanced/strict) or a bounded pre-authorization on these workflows.",
            ...workflowEffectRisks.unattendedExternalSends,
          ],
        }
      : {
          id: "workflow-unattended-sends",
          title: "Unattended external sends without an approval policy",
          status: "ok",
          summary: "No active unattended workflow sends externally without an approval policy.",
        },
  );

  const mcpFindings: SecurityAuditFinding[] = [];
  const activeMcpConfigs = mcpConfigs.filter((entry) => entry.normalized.enabled !== false);
  const missingTrustTier = activeMcpConfigs
    .filter((entry) => typeof entry.raw.trustTier !== "string" || !String(entry.raw.trustTier).trim())
    .map((entry) => entry.normalized.name);
  const unrestrictedHighTrust = activeMcpConfigs
    .filter((entry) => entry.normalized.trustTier === "high" && (entry.normalized.allowedAgents?.length || 0) === 0)
    .map((entry) => entry.normalized.name);
  const approvalGaps = activeMcpConfigs.flatMap((entry) => {
    const toolPolicies = entry.normalized.tools?.policies || {};
    const policyNames = Object.keys(toolPolicies);
    if ((entry.normalized.defaultApprovalMode || "off") !== "off") return [];
    return policyNames
      .filter((toolName) => toolPolicies[toolName]?.readonly !== true && (toolPolicies[toolName]?.approvalMode || "off") === "off")
      .map((toolName) => `${entry.normalized.name}:${toolName}`);
  });

  if (activeMcpConfigs.length === 0) {
    mcpFindings.push({
      id: "mcp-config",
      title: "Configured MCP servers",
      status: "ok",
      summary: "No active MCP servers are configured.",
    });
  } else {
    mcpFindings.push({
      id: "mcp-config",
      title: "Configured MCP servers",
      status: "ok",
      summary: `${activeMcpConfigs.length} active MCP server(s) configured.`,
      details: activeMcpConfigs.map((entry) => {
        const config = entry.normalized;
        return `${config.name}: trust=${config.trustTier || "medium"}, approval=${config.defaultApprovalMode || "off"}, allowedAgents=${config.allowedAgents?.length || 0}, resources=${config.tools?.resources === false ? "off" : "on"}, prompts=${config.tools?.prompts === false ? "off" : "on"}`;
      }),
    });
  }
  mcpFindings.push(
    missingTrustTier.length > 0
      ? {
          id: "mcp-trust-tier",
          title: "MCP trust tier classification",
          status: "warn",
          summary: `${missingTrustTier.length} active MCP server(s) rely on the default trust tier because trustTier is not set explicitly.`,
          details: missingTrustTier,
        }
      : {
          id: "mcp-trust-tier",
          title: "MCP trust tier classification",
          status: "ok",
          summary: activeMcpConfigs.length > 0
            ? "All active MCP servers set trustTier explicitly."
            : "No active MCP trust tiers to evaluate.",
        },
  );
  mcpFindings.push(
    unrestrictedHighTrust.length > 0
      ? {
          id: "mcp-high-trust-agents",
          title: "High-trust MCP agent scoping",
          status: "warn",
          summary: `${unrestrictedHighTrust.length} high-trust MCP server(s) are available to every agent.`,
          details: unrestrictedHighTrust,
        }
      : {
          id: "mcp-high-trust-agents",
          title: "High-trust MCP agent scoping",
          status: "ok",
          summary: "No high-trust MCP server is left globally available without agent scoping.",
        },
  );
  mcpFindings.push(
    approvalGaps.length > 0
      ? {
          id: "mcp-tool-approval",
          title: "MCP tool approval classification",
          status: "warn",
          summary: `${approvalGaps.length} MCP tool policy entry or entries are marked writable/unknown without any approval requirement.`,
          details: approvalGaps,
        }
      : {
          id: "mcp-tool-approval",
          title: "MCP tool approval classification",
          status: "ok",
          summary: "Configured MCP tool policies do not include obvious writable approval gaps.",
        },
  );

  const areas: SecurityAuditArea[] = [
    {
      id: "access",
      title: "Access Boundaries",
      description: "Control-plane auth and API exposure inventory.",
      status: statusFromFindings(accessFindings),
      findings: accessFindings,
    },
    {
      id: "secrets-auth",
      title: "Secrets & Auth",
      description: "Token, secret, and ingress-auth posture.",
      status: statusFromFindings(secretAndAuthFindings),
      findings: secretAndAuthFindings,
    },
    {
      id: "browser-network",
      title: "Browser & Network",
      description: "Browser write protections, origin trust, and proxy posture.",
      status: statusFromFindings(browserNetworkFindings),
      findings: browserNetworkFindings,
    },
    {
      id: "ingress",
      title: "Ingress & Webhooks",
      description: "Public ingress routes, callbacks, signing, and provenance.",
      status: statusFromFindings(ingressFindings),
      findings: ingressFindings,
    },
    {
      id: "execution",
      title: "Execution Safeguards",
      description: "Command-execution defenses and active workflow policy.",
      status: statusFromFindings(executionFindings),
      findings: executionFindings,
    },
    {
      id: "mcp",
      title: "MCP Policy",
      description: "Trust, scoping, and utility exposure for MCP servers.",
      status: statusFromFindings(mcpFindings),
      findings: mcpFindings,
    },
  ];

  let errors = 0;
  let warnings = 0;
  for (const area of areas) {
    for (const finding of area.findings) {
      if (finding.status === "error") errors += 1;
      else if (finding.status === "warn") warnings += 1;
    }
  }

  const recommendations: string[] = [];
  if (!adminTokenConfigured) {
    recommendations.push("Set DISP8CH_ADMIN_TOKEN before exposing the app beyond localhost.");
  }
  if (!wsAuthTokenConfigured) {
    recommendations.push("Set WS_AUTH_TOKEN if WebSocket clients will connect outside your current browser session.");
  }
  if (!teamsAllowlistConfigured) {
    recommendations.push("Set TEAMS_ALLOWED_SERVICE_HOSTS before enabling Teams in environments you do not fully trust.");
  }
  if (trustProxyEnabled) {
    recommendations.push("Keep DISP8CH_TRUST_PROXY off unless the app is behind a fixed trusted proxy you control.");
  }
  if (websitePolicy.mode === "off") {
    recommendations.push("Use website_policy_mode=blocklist if you want to forbid browsing, scraping, and direct HTTP access to specific domains.");
  } else if (websitePolicy.mode === "allowlist") {
    recommendations.push("Keep website_policy_domains tightly scoped when using allowlist mode so browser, HTTP, scrape, and targeted search access stay least-privilege.");
  }
  if (acpAuthMode === "off") {
    recommendations.push("Enable ACP bearer auth before exposing /api/acp to external callers.");
  } else if (!acpAuthConfigured) {
    recommendations.push("Finish ACP bearer token setup so bearer mode actually protects /api/acp.");
  }
  if (provenanceMode !== "meta+receipt") {
    recommendations.push("Use provenance_mode=meta+receipt for stronger external ingress audit trails.");
  }
  if (activeAgentPolicies.fullNoApprovalAgents > 0) {
    recommendations.push("Move sensitive workflows from execSecurity=full to allowlist or approval-backed execution.");
  }
  if (workflowEffectRisks.unattendedExternalSends.length > 0) {
    recommendations.push("Add an approval policy (balanced/strict) to workflows that send externally on unattended triggers.");
  }
  if (workflowEffectRisks.legacyMemoryNodes.length > 0) {
    recommendations.push("Set Memory access to \"This workflow\" on memory/agent nodes that should not share the agent's global memory.");
  }
  if (routeInventory.unexpectedPublicRoutes.length > 0) {
    recommendations.push("Gate or explicitly classify every unexpected public API route found by the audit.");
  }
  if (missingTrustTier.length > 0) {
    recommendations.push("Set trustTier explicitly on every active MCP server so low/high-risk integrations are reviewable at a glance.");
  }
  if (unrestrictedHighTrust.length > 0) {
    recommendations.push("Restrict high-trust MCP servers with allowedAgents so broad agent access does not become the default.");
  }
  if (approvalGaps.length > 0) {
    recommendations.push("Assign approvalMode or readonly metadata to writable MCP tools instead of leaving them as off/unknown.");
  }

  return {
    ok: errors === 0,
    checkedAt: new Date().toISOString(),
    errors,
    warnings,
    summary: {
      totalRoutes: routeInventory.totalRoutes,
      protectedRoutes: routeInventory.protectedRoutes,
      operatorRoutes: routeInventory.operatorRoutes,
      adminRoutes: routeInventory.adminRoutes,
      mixedRoutes: routeInventory.mixedRoutes.length,
      publicRoutes: routeInventory.publicRoutes.length,
      publicStateChangingRoutes,
      unexpectedPublicRoutes: routeInventory.unexpectedPublicRoutes.length,
      adminTokenConfigured,
      wsAuthTokenConfigured,
      secretsEncrypted: secretsStatus.masterKeyConfigured,
      teamsAllowlistConfigured,
      websitePolicyMode: websitePolicy.mode,
      websitePolicyDomains: websitePolicy.domains.length,
      installPosture: securityRuntime.installPosture,
      loopbackBypassEnabled: !securityRuntime.disableLoopbackBypass,
      operatorAuthBackoffEnabled: securityRuntime.operatorAuthBackoffEnabled,
    },
    areas,
    publicRoutes: routeInventory.publicRoutes,
    mixedRoutes: routeInventory.mixedRoutes,
    recommendations,
  };
}
