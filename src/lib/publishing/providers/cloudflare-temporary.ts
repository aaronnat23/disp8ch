import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PublishProvider, PublishRequest, PublishResult } from "../types";

const execFileAsync = promisify(execFile);

function npxInvocation(args: string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable: "npx", args };
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!fs.existsSync(npxCli)) throw new Error("npm's npx-cli.js was not found beside the active Windows Node.js runtime.");
  return { executable: process.execPath, args: [npxCli, ...args] };
}

function safeName(artifactId: string): string {
  const suffix = artifactId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(-40);
  return `disp8ch-${suffix || "preview"}`.slice(0, 63);
}

async function runWrangler(args: string[], cwd?: string): Promise<string> {
  const invocation = npxInvocation(["--yes", "wrangler@latest", ...args]);
  const result = await execFileAsync(invocation.executable, invocation.args, {
    cwd,
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 4_000_000,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  return `${result.stdout}\n${result.stderr}`;
}

async function deploy(request: PublishRequest): Promise<PublishResult> {
  if (request.visibility !== "public") throw new Error("Cloudflare temporary previews support public visibility only.");
  if (request.expiresAt) throw new Error("Cloudflare temporary previews do not provide a configurable expiry.");
  const root = await mkdtemp(path.join(os.tmpdir(), "disp8ch-cf-preview-"));
  try {
    const publicDir = path.join(root, "public");
    await mkdir(publicDir, { recursive: true });
    for (const file of request.files) {
      const target = path.resolve(publicDir, ...file.path.split("/"));
      const relative = path.relative(publicDir, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Publish manifest contains a path escape.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    const projectName = String(request.existingMetadata?.projectName || safeName(request.artifactId));
    await writeFile(path.join(root, "wrangler.jsonc"), JSON.stringify({
      name: projectName,
      compatibility_date: new Date().toISOString().slice(0, 10),
      assets: { directory: "./public", not_found_handling: "single-page-application" },
    }, null, 2));
    const output = await runWrangler(["deploy", "--temporary", "--name", projectName], root);
    const publicUrl = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
    const claimUrl = output.match(/https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s]+/i)?.[0];
    if (!publicUrl) throw new Error(`Cloudflare temporary deploy did not return a public URL: ${output.slice(-1200)}`);
    return {
      provider: "cloudflare-temporary",
      remoteId: projectName,
      url: publicUrl,
      status: "live",
      providerMetadata: { projectName, deploymentUrl: publicUrl },
      oneTimeClaimUrl: claimUrl,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const cloudflareTemporaryPublishProvider: PublishProvider = {
  id: "cloudflare-temporary",
  capabilities: { stableUrl: true, protectedVisibility: false, expiry: false, feedback: false },
  async validateConfiguration() {
    try {
      const invocation = npxInvocation(["--version"]);
      await execFileAsync(invocation.executable, invocation.args, { timeout: 10_000, windowsHide: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: "Node.js npx is required for Cloudflare temporary previews." };
    }
  },
  publish: deploy,
  update: deploy,
  async revoke(remoteId) {
    await runWrangler(["delete", "--name", remoteId, "--force"]);
  },
};
