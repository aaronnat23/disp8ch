import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { auditAcceptance } from "@/lib/dynamic-workflows/criteria";
import { getDesignArtifactById, listDesignValidationReports, readDesignArtifactVersionSource } from "@/lib/design-studio/store";
import { validateDesignHtml } from "@/lib/design-studio/html";
import { getConnectedProject } from "@/lib/projects/store";
import { resolveSecretValue } from "@/lib/secrets/store";
import type { DeployableSource, PublishManifest, PublishRequest } from "./types";

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const SECRET_FILE = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.json|.*\.(?:pem|key|p12|pfx|jks))$/i;
const SECRET_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b)/;

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

async function validateStaticBundle(files: PublishRequest["files"]): Promise<Record<string, unknown>> {
  const byPath = new Map(files.map((file) => [`/${file.path.replace(/^\/+/, "")}`, file]));
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const exact = byPath.get(pathname === "/" ? "/index.html" : pathname);
    const selected = exact || (path.extname(pathname) ? undefined : byPath.get("/index.html"));
    if (!selected) { response.writeHead(404).end("Not found"); return; }
    response.writeHead(200, { "content-type": selected.contentType, "cache-control": "no-store" });
    response.end(selected.content);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start isolated publish validation server.");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const viewports = [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }];
    const checks: Record<string, unknown> = {};
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors: string[] = [];
      page.on("console", (event) => { if (event.type() === "error") errors.push(event.text().slice(0, 500)); });
      page.on("pageerror", (error) => errors.push(error.message.slice(0, 500)));
      const response = await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle", timeout: 30_000 });
      const metrics = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        hasVisibleContent: Boolean(document.body?.innerText.trim()) || Boolean(document.querySelector("img,svg,canvas,video")),
        bodyWidth: document.body?.getBoundingClientRect().width || 0,
        bodyHeight: document.body?.getBoundingClientRect().height || 0,
      }));
      await page.close();
      if (!response?.ok()) throw new Error(`Publishing blocked: ${viewport.name} preview returned HTTP ${response?.status() || 0}.`);
      if (errors.length) throw new Error(`Publishing blocked by ${viewport.name} console/page errors: ${errors.join(" ")}`);
      if (metrics.horizontalOverflow) throw new Error(`Publishing blocked by horizontal overflow at ${viewport.name} size.`);
      if (!metrics.hasVisibleContent || metrics.bodyWidth < 10 || metrics.bodyHeight < 10) throw new Error(`Publishing blocked by a blank ${viewport.name} render.`);
      checks[viewport.name] = { ok: true, ...metrics };
    }
    return checks;
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function feedbackFile(artifactId: string, versionId: string): PublishRequest["files"][number] | null {
  const raw = resolveSecretValue("DISP8CH_FEEDBACK_SUBMIT_URL") || process.env.DISP8CH_FEEDBACK_SUBMIT_URL || "";
  if (!raw) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("DISP8CH_FEEDBACK_SUBMIT_URL must use HTTPS.");
  const endpoint = JSON.stringify(parsed.toString()).replace(/</g, "\\u003c");
  const safeArtifactId = JSON.stringify(artifactId).replace(/</g, "\\u003c");
  const safeVersionId = JSON.stringify(versionId).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send feedback</title><style>body{font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px;color:#141110}textarea,input{box-sizing:border-box;width:100%;padding:12px;margin-top:8px}textarea{min-height:180px}button{margin-top:12px;padding:10px 16px;background:#c8331f;color:white;border:0}p{line-height:1.5}.status{font-size:14px}</style></head><body><h1>Send feedback</h1><p>Your feedback is untrusted text and can only propose work for operator review.</p><form id="feedback"><textarea name="body" maxlength="5000" required aria-label="Feedback"></textarea><input name="contact" maxlength="300" placeholder="Contact (optional)"><button type="submit">Submit feedback</button></form><p class="status" id="status" role="status"></p><script>const endpoint=${endpoint},artifactId=${safeArtifactId},versionId=${safeVersionId};document.getElementById('feedback').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('status'),form=new FormData(e.currentTarget);status.textContent='Sending...';try{const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({artifactId,versionId,publicUrl:location.origin,body:String(form.get('body')||''),contact:String(form.get('contact')||'')})});if(!r.ok)throw new Error('Request failed');e.currentTarget.reset();status.textContent='Feedback received for review.'}catch{status.textContent='Could not send feedback. Please try again.'}});</script></body></html>`;
  return { path: "feedback.html", content: Buffer.from(html), sha256: sha256(html), contentType: "text/html; charset=utf-8" };
}

function designManifest(source: Extract<DeployableSource, { type: "design" }>, supervisedRunId?: string | null): PublishManifest {
  const artifact = getDesignArtifactById(source.artifactId);
  if (!artifact) throw new Error("Design artifact not found.");
  const version = artifact.versions.find((candidate) => candidate.id === source.versionId);
  if (!version) throw new Error("The selected immutable artifact version does not exist.");
  const html = readDesignArtifactVersionSource(artifact.id, version.id);
  const validation = validateDesignHtml(html);
  if (!validation.ok) throw new Error(`Publishing blocked by HTML validation: ${validation.errors.join(" ")}`);
  const report = listDesignValidationReports(artifact.id, 50).find((candidate) => candidate.versionId === version.id)?.report as Record<string, unknown> | undefined;
  if (!report || report.ok !== true) throw new Error("Publishing requires a passing Playwright preview report for the selected version.");
  const metrics = report.metrics as Record<string, unknown> | undefined;
  const screenshots = report.screenshots as Record<string, unknown> | undefined;
  if (!screenshots?.desktop || !screenshots?.mobile) throw new Error("Publishing requires desktop and mobile preview screenshots.");
  if (Array.isArray(report.consoleErrors) && report.consoleErrors.length > 0) throw new Error("Publishing blocked by console or page errors.");
  if (metrics?.horizontalOverflow === true) throw new Error("Publishing blocked by horizontal overflow.");
  const legacyBlankRender = metrics?.blankRenderDetected === undefined
    && typeof metrics?.blankPixelRatio === "number"
    && metrics.blankPixelRatio > 0.9;
  if (metrics?.blankRenderDetected === true || legacyBlankRender) throw new Error("Publishing blocked by a blank render.");
  const legacyBlankCanvas = metrics?.canvasBlankRenderDetected === undefined
    && typeof metrics?.canvasBlankPixelRatio === "number"
    && metrics.canvasBlankPixelRatio > 0.9;
  if (metrics?.canvasBlankRenderDetected === true || legacyBlankCanvas) throw new Error("Publishing blocked by a blank canvas.");
  if (supervisedRunId && !auditAcceptance(supervisedRunId).passed) throw new Error("Publishing blocked because the linked supervised run has failed or unverified required criteria.");
  const files: PublishRequest["files"] = [{ path: "index.html", content: Buffer.from(html), sha256: sha256(html), contentType: "text/html; charset=utf-8" }];
  const feedback = feedbackFile(artifact.id, version.id);
  if (feedback) files.push(feedback);
  return { artifact: { id: artifact.id, title: artifact.title, sourceType: "design" }, version: { id: version.id }, files, report, feedbackEnabled: Boolean(feedback) };
}

function encodeProjectArtifactId(projectId: string, outputPath: string): string {
  return `project:${projectId}:${Buffer.from(outputPath, "utf8").toString("base64url")}`;
}

export function decodeProjectArtifactId(artifactId: string): Extract<DeployableSource, { type: "project" }> | null {
  const match = artifactId.match(/^project:([^:]+):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  try { return { type: "project", projectId: match[1], outputPath: Buffer.from(match[2], "base64url").toString("utf8") }; } catch { return null; }
}

async function projectManifest(source: Extract<DeployableSource, { type: "project" }>, supervisedRunId?: string | null): Promise<PublishManifest> {
  const project = getConnectedProject(source.projectId);
  if (!project) throw new Error("Connected project not found.");
  if (!source.outputPath.trim() || path.isAbsolute(source.outputPath) || source.outputPath.includes("\0")) throw new Error("Publish output must be a project-relative directory.");
  const canonicalRoot = await fs.realpath(project.canonicalRoot);
  const outputRoot = await fs.realpath(path.resolve(canonicalRoot, source.outputPath));
  if (!inside(canonicalRoot, outputRoot) || outputRoot === canonicalRoot) throw new Error("Publish output must be a contained project subdirectory.");
  if (!(await fs.stat(outputRoot)).isDirectory()) throw new Error("Publish output is not a directory.");
  const files: PublishRequest["files"] = [];
  let totalBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(outputRoot, absolute).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) throw new Error(`Publishing blocked by symlink: ${relative}`);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES) throw new Error(`Publishing supports at most ${MAX_FILES} files.`);
      if (SECRET_FILE.test(entry.name)) throw new Error(`Publishing blocked possible secret file: ${relative}`);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Publishing blocked oversized file: ${relative}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Publishing supports at most 50 MiB per static site.");
      const real = await fs.realpath(absolute);
      if (!inside(outputRoot, real)) throw new Error(`Publishing blocked path escape: ${relative}`);
      const content = await fs.readFile(real);
      if (content.length < 2_000_000 && SECRET_CONTENT.test(content.toString("utf8"))) throw new Error(`Publishing blocked possible embedded secret: ${relative}`);
      files.push({ path: relative, content, sha256: sha256(content), contentType: contentType(relative) });
    }
  };
  await walk(outputRoot);
  const index = files.find((file) => file.path.toLowerCase() === "index.html");
  if (!index) throw new Error("Publish output requires an index.html file.");
  const htmlValidation = validateDesignHtml(index.content.toString("utf8"));
  if (!htmlValidation.ok) throw new Error(`Publishing blocked by HTML validation: ${htmlValidation.errors.join(" ")}`);
  if (supervisedRunId && !auditAcceptance(supervisedRunId).passed) throw new Error("Publishing blocked because the linked supervised run has failed or unverified required criteria.");
  files.sort((a, b) => a.path.localeCompare(b.path));
  const versionId = `bundle_${sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n")).slice(0, 24)}`;
  const artifactId = encodeProjectArtifactId(project.id, source.outputPath.replace(/\\/g, "/"));
  const browserChecks = await validateStaticBundle(files);
  const feedback = feedbackFile(artifactId, versionId);
  if (feedback && !files.some((file) => file.path === feedback.path)) files.push(feedback);
  return {
    artifact: { id: artifactId, title: `${project.name}/${source.outputPath}`, sourceType: "project" },
    version: { id: versionId }, files,
    report: { ok: true, source: "connected-project", htmlValidation, browserChecks, fileCount: files.length, totalBytes, secretScan: "passed", symlinkScan: "passed" },
    feedbackEnabled: Boolean(feedback),
  };
}

export async function buildPublishManifest(input: {
  source?: DeployableSource;
  artifactId?: string;
  versionId?: string;
  supervisedRunId?: string | null;
}): Promise<PublishManifest> {
  const source = input.source || (input.artifactId && input.versionId
    ? decodeProjectArtifactId(input.artifactId) || { type: "design" as const, artifactId: input.artifactId, versionId: input.versionId }
    : null);
  if (!source) throw new Error("A deployable source is required.");
  return source.type === "design" ? designManifest(source, input.supervisedRunId) : projectManifest(source, input.supervisedRunId);
}
