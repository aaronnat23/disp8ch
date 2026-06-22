import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDocumentFromIntegration, type DocumentRecord } from "@/lib/documents/store";

const execFileAsync = promisify(execFile);

type IntegrationCommand = {
  command: string;
  args: string[];
};

function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf("{")), trimmed.slice(trimmed.indexOf("["))].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next slice.
    }
  }
  return trimmed;
}

async function resolveCommand(binaryName: string): Promise<string | null> {
  const envOverride = process.env.GOOGLE_WORKSPACE_CLI_BIN;
  if (envOverride?.trim()) return envOverride.trim();

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookupCommand, [binaryName]);
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

async function buildGoogleWorkspaceCommand(args: string[]): Promise<IntegrationCommand> {
  const direct = await resolveCommand("gws");
  if (direct) return { command: direct, args };
  return { command: "npx", args: ["-y", "@googleworkspace/cli", ...args] };
}

async function runJsonCommand(command: IntegrationCommand, env?: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = extractJsonPayload(stdout);
    if (payload === null && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return payload;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const extra = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join("\n");
    const message = extra || err.message || String(error);
    throw new Error(message.replace(/^Error:\s*/, ""));
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function getHeaderValue(payload: Record<string, unknown>, name: string): string | null {
  const nestedHeaders =
    payload.payload && typeof payload.payload === "object"
      ? (payload.payload as Record<string, unknown>).headers
      : undefined;
  const headers = asArray<Record<string, unknown>>(payload.headers ?? nestedHeaders);
  const hit = headers.find((header) => String(header.name || "").toLowerCase() === name.toLowerCase());
  const value = hit?.value;
  return value ? String(value) : null;
}

function decodeBase64Url(input: string): string {
  try {
    return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailText(payload: Record<string, unknown>): string {
  const recurse = (part: Record<string, unknown>): string => {
    const body = part.body as Record<string, unknown> | undefined;
    const data = typeof body?.data === "string" ? decodeBase64Url(body.data) : "";
    if (data.trim()) return data.trim();
    const parts = asArray<Record<string, unknown>>(part.parts);
    return parts.map(recurse).filter(Boolean).join("\n\n");
  };
  const rootPayload = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  return recurse(rootPayload).trim() || String(payload.snippet || "").trim();
}

async function ensureGoogleWorkspaceAuthenticated(): Promise<void> {
  const authCommand = await buildGoogleWorkspaceCommand(["auth", "status"]);
  const payload = await runJsonCommand(authCommand);
  const status = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (String(status.auth_method || "none") === "none") {
    throw new Error("Google Workspace CLI is not authenticated. Run `gws auth setup` and `gws auth login` first.");
  }
}

export async function importGoogleWorkspaceToDocument(params: {
  mode: "gmail" | "drive";
  query?: string;
  maxResults?: number;
}): Promise<DocumentRecord> {
  const maxResults = Math.max(1, Math.min(10, Number(params.maxResults) || 5));
  await ensureGoogleWorkspaceAuthenticated();

  if (params.mode === "gmail") {
    const listCommand = await buildGoogleWorkspaceCommand([
      "gmail",
      "users",
      "messages",
      "list",
      "--params",
      JSON.stringify({
        userId: "me",
        maxResults,
        ...(params.query?.trim() ? { q: params.query.trim() } : {}),
      }),
    ]);
    const listPayload = await runJsonCommand(listCommand);
    const messageRows = asArray<Record<string, unknown>>(
      (listPayload as Record<string, unknown> | null)?.messages,
    );
    const messages = [];
    for (const row of messageRows.slice(0, maxResults)) {
      const id = String(row.id || "").trim();
      if (!id) continue;
      const getCommand = await buildGoogleWorkspaceCommand([
        "gmail",
        "users",
        "messages",
        "get",
        "--params",
        JSON.stringify({
          userId: "me",
          id,
          format: "full",
        }),
      ]);
      const fullPayload = await runJsonCommand(getCommand) as Record<string, unknown>;
      messages.push(fullPayload);
    }

    const lines = [
      `Google Workspace Gmail snapshot${params.query?.trim() ? ` for query "${params.query.trim()}"` : ""}`,
      `Messages captured: ${messages.length}`,
      "",
      ...messages.map((message, index) => {
        const subject = getHeaderValue(message, "Subject") || "(no subject)";
        const from = getHeaderValue(message, "From") || "(unknown sender)";
        const date = getHeaderValue(message, "Date") || "(unknown date)";
        const body = extractGmailText(message).slice(0, 4000);
        return [`${index + 1}. ${subject}`, `From: ${from}`, `Date: ${date}`, "", body].join("\n");
      }),
    ].join("\n");

    return createDocumentFromIntegration({
      name: `gmail-snapshot-${Date.now()}`,
      extractedText: lines,
      metadata: {
        provider: "gws",
        mode: "gmail",
        query: params.query || null,
        maxResults,
      },
    });
  }

  const driveCommand = await buildGoogleWorkspaceCommand([
    "drive",
    "files",
    "list",
    "--params",
    JSON.stringify({
      pageSize: maxResults,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,size),nextPageToken",
      ...(params.query?.trim() ? { q: params.query.trim() } : {}),
    }),
  ]);
  const drivePayload = await runJsonCommand(driveCommand) as Record<string, unknown>;
  const files = asArray<Record<string, unknown>>(drivePayload.files);
  const lines = [
    `Google Workspace Drive snapshot${params.query?.trim() ? ` for query "${params.query.trim()}"` : ""}`,
    `Files captured: ${files.length}`,
    "",
    ...files.map((file, index) =>
      [
        `${index + 1}. ${String(file.name || "(unnamed)")}`,
        `ID: ${String(file.id || "")}`,
        `Type: ${String(file.mimeType || "unknown")}`,
        `Modified: ${String(file.modifiedTime || "unknown")}`,
        file.webViewLink ? `URL: ${String(file.webViewLink)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");

  return createDocumentFromIntegration({
    name: `drive-snapshot-${Date.now()}`,
    extractedText: lines,
    metadata: {
      provider: "gws",
      mode: "drive",
      query: params.query || null,
      maxResults,
      files,
    },
  });
}
