import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { ensureDesignArtifactDirs, getDesignVersionPath } from "@/lib/design-studio/paths";
import { validateDesignHtml } from "@/lib/design-studio/html";
import type {
  CreateDesignArtifactInput,
  CreateDesignProjectInput,
  DesignArtifactDetail,
  DesignArtifactSummary,
  DesignArtifactVersion,
  DesignProjectDetail,
  DesignProjectSummary,
  SaveDesignArtifactVersionInput,
} from "@/lib/design-studio/types";

function id(prefix: "desproj" | "desart" | "desver" | "despatch"): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

function genericId(prefix: "dessys" | "desval" | "desasset"): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function projectRow(row: any): DesignProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    activeArtifactId: row.active_artifact_id ?? null,
    artifactCount: Number(row.artifact_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactRow(row: any): DesignArtifactSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind,
    entryFile: row.entry_file,
    status: row.status,
    currentVersionId: row.current_version_id ?? null,
    currentVersionNumber: row.current_version_number == null ? null : Number(row.current_version_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionRow(row: any): DesignArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    versionNumber: Number(row.version_number),
    sizeBytes: Number(row.size_bytes || 0),
    contentSha256: row.content_sha256,
    summary: row.summary ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function patchRow(row: any) {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    versionBeforeId: row.version_before_id ?? null,
    versionAfterId: row.version_after_id ?? null,
    patchKind: row.patch_kind,
    label: row.label,
    patchJson: row.patch_json,
    source: row.source,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
  };
}

export function listDesignProjects(): DesignProjectSummary[] {
  const rows = getSqlite().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM design_artifacts a WHERE a.project_id = p.id) AS artifact_count
    FROM design_projects p
    ORDER BY p.updated_at DESC
  `).all();
  return rows.map(projectRow);
}

export function getDesignProject(projectId: string): DesignProjectDetail | null {
  const project = getSqlite().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM design_artifacts a WHERE a.project_id = p.id) AS artifact_count
    FROM design_projects p
    WHERE p.id = ?
  `).get(projectId);
  if (!project) return null;
  return { ...projectRow(project), artifacts: listDesignArtifacts(projectId) };
}

export function createDesignProject(input: CreateDesignProjectInput): DesignProjectDetail {
  const now = nowIso();
  const projectId = id("desproj");
  const name = String(input.name || "").trim() || "Untitled Design Project";
  withSqliteWriteRecovery("design-project:create", (db) => {
    db.prepare(`
      INSERT INTO design_projects
        (id, name, description, status, organization_id, goal_id, source_session_id, active_artifact_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, '{}', ?, ?)
    `).run(projectId, name, input.description ?? null, input.organizationId ?? null, input.goalId ?? null, input.sourceSessionId ?? null, now, now);
  });
  return getDesignProject(projectId)!;
}

export function listDesignArtifacts(projectId: string): DesignArtifactSummary[] {
  const rows = getSqlite().prepare(`
    SELECT a.*, v.version_number AS current_version_number
    FROM design_artifacts a
    LEFT JOIN design_artifact_versions v ON v.id = a.current_version_id
    WHERE a.project_id = ?
    ORDER BY a.updated_at DESC
  `).all(projectId);
  return rows.map(artifactRow);
}

export function listRecentDesignArtifacts(limit = 12): DesignArtifactSummary[] {
  const rows = getSqlite().prepare(`
    SELECT a.*, v.version_number AS current_version_number
    FROM design_artifacts a
    LEFT JOIN design_artifact_versions v ON v.id = a.current_version_id
    ORDER BY a.updated_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, limit)));
  return rows.map(artifactRow);
}

export function listDesignArtifactVersions(artifactId: string): DesignArtifactVersion[] {
  const rows = getSqlite().prepare(`
    SELECT id, artifact_id, version_number, content_sha256, size_bytes, summary, created_by, created_at
    FROM design_artifact_versions
    WHERE artifact_id = ?
    ORDER BY version_number DESC
  `).all(artifactId);
  return rows.map(versionRow);
}

export function listDesignPatches(artifactId: string, limit = 30) {
  const rows = getSqlite().prepare(`
    SELECT id, artifact_id, version_before_id, version_after_id, patch_kind, label, patch_json, source, session_id, created_at
    FROM design_patches
    WHERE artifact_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(artifactId, Math.max(1, Math.min(100, limit)));
  return rows.map(patchRow);
}

export function getDesignArtifactById(artifactId: string): DesignArtifactDetail | null {
  const row = getSqlite().prepare(`
    SELECT a.*, v.version_number AS current_version_number
    FROM design_artifacts a
    LEFT JOIN design_artifact_versions v ON v.id = a.current_version_id
    WHERE a.id = ?
  `).get(artifactId);
  if (!row) return null;
  const summary = artifactRow(row);
  const source = readCurrentArtifactSource(summary.id);
  return {
    ...summary,
    project: getDesignProject(summary.projectId),
    currentSource: source,
    validation: validateDesignHtml(source),
    versions: listDesignArtifactVersions(summary.id),
    patches: listDesignPatches(summary.id),
  };
}

export function createDesignArtifact(input: CreateDesignArtifactInput): DesignArtifactDetail {
  const validation = validateDesignHtml(input.html);
  if (!validation.ok) throw new Error(`Invalid design HTML: ${validation.errors.join(" ")}`);
  let projectId = String(input.projectId || "").trim();
  if (!projectId) {
    projectId = createDesignProject({ name: input.projectName || `${input.title} Project`, sourceSessionId: input.sourceSessionId }).id;
  }
  const project = getDesignProject(projectId);
  if (!project) throw new Error("Design project not found");
  const now = nowIso();
  const artifactId = id("desart");
  const versionId = id("desver");
  const title = String(input.title || "").trim() || "Untitled Artifact";
  ensureDesignArtifactDirs(projectId, artifactId);
  const versionPath = getDesignVersionPath(projectId, artifactId, 1);
  fs.mkdirSync(path.dirname(versionPath), { recursive: true });
  fs.writeFileSync(versionPath, input.html, "utf8");
  withSqliteWriteRecovery("design-artifact:create", (db) => {
    db.prepare(`
      INSERT INTO design_artifacts
        (id, project_id, title, kind, entry_file, status, current_version_id, source_session_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'html', 'index.html', 'draft', ?, ?, '{}', ?, ?)
    `).run(artifactId, projectId, title, versionId, input.sourceSessionId ?? null, now, now);
    db.prepare(`
      INSERT INTO design_artifact_versions
        (id, artifact_id, version_number, file_path, content_sha256, size_bytes, summary, created_by, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(versionId, artifactId, versionPath, sha256(input.html), Buffer.byteLength(input.html), input.summary ?? "Initial version", input.createdBy ?? "system", now);
    db.prepare("UPDATE design_projects SET active_artifact_id = ?, updated_at = ? WHERE id = ?").run(artifactId, now, projectId);
  });
  return getDesignArtifactById(artifactId)!;
}

export function saveDesignArtifactVersion(input: SaveDesignArtifactVersionInput): DesignArtifactDetail {
  const artifact = getDesignArtifactById(input.artifactId);
  if (!artifact) throw new Error("Design artifact not found");
  const validation = validateDesignHtml(input.html);
  if (!validation.ok) throw new Error(`Invalid design HTML: ${validation.errors.join(" ")}`);
  const latest = listDesignArtifactVersions(artifact.id)[0];
  const nextNumber = (latest?.versionNumber ?? 0) + 1;
  const versionId = id("desver");
  const versionPath = getDesignVersionPath(artifact.projectId, artifact.id, nextNumber);
  if (fs.existsSync(versionPath)) throw new Error("Version file already exists");
  fs.mkdirSync(path.dirname(versionPath), { recursive: true });
  fs.writeFileSync(versionPath, input.html, "utf8");
  const now = nowIso();
  withSqliteWriteRecovery("design-artifact:save-version", (db) => {
    db.prepare(`
      INSERT INTO design_artifact_versions
        (id, artifact_id, version_number, file_path, content_sha256, size_bytes, summary, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, artifact.id, nextNumber, versionPath, sha256(input.html), Buffer.byteLength(input.html), input.summary ?? null, input.createdBy ?? "user", now);
    db.prepare("UPDATE design_artifacts SET current_version_id = ?, updated_at = ? WHERE id = ?").run(versionId, now, artifact.id);
    db.prepare("UPDATE design_projects SET active_artifact_id = ?, updated_at = ? WHERE id = ?").run(artifact.id, now, artifact.projectId);
  });
  return getDesignArtifactById(artifact.id)!;
}

export function recordDesignPatch(params: {
  artifactId: string;
  versionBeforeId?: string | null;
  versionAfterId?: string | null;
  patchKind: string;
  label: string;
  patch: unknown;
  source?: string;
  sessionId?: string | null;
}) {
  const patchId = id("despatch");
  const now = nowIso();
  withSqliteWriteRecovery("design-patch:record", (db) => {
    db.prepare(`
      INSERT INTO design_patches
        (id, artifact_id, version_before_id, version_after_id, patch_kind, label, patch_json, source, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      patchId,
      params.artifactId,
      params.versionBeforeId ?? null,
      params.versionAfterId ?? null,
      params.patchKind,
      params.label,
      JSON.stringify(params.patch ?? {}),
      params.source ?? "manual",
      params.sessionId ?? null,
      now,
    );
  });
  return listDesignPatches(params.artifactId, 1)[0] ?? null;
}

export function rollbackDesignArtifactToVersion(artifactId: string, versionNumber: number, createdBy = "rollback"): DesignArtifactDetail {
  const artifact = getDesignArtifactById(artifactId);
  if (!artifact) throw new Error("Design artifact not found");
  const target = listDesignArtifactVersions(artifactId).find((version) => version.versionNumber === versionNumber);
  if (!target) throw new Error(`Version not found: v${versionNumber}`);
  const row = getSqlite().prepare("SELECT file_path FROM design_artifact_versions WHERE id = ?").get(target.id) as { file_path?: string } | undefined;
  if (!row?.file_path) throw new Error("Version source file not found");
  const source = fs.readFileSync(row.file_path, "utf8");
  const updated = saveDesignArtifactVersion({
    artifactId,
    html: source,
    summary: `Rollback to v${versionNumber}`,
    createdBy,
  });
  recordDesignPatch({
    artifactId,
    versionBeforeId: artifact.currentVersionId,
    versionAfterId: updated.currentVersionId,
    patchKind: "rollback",
    label: `Rollback to v${versionNumber}`,
    patch: { kind: "rollback", versionNumber },
    source: createdBy,
  });
  return updated;
}

export function readCurrentArtifactSource(artifactId: string): string {
  const row = getSqlite().prepare(`
    SELECT v.file_path
    FROM design_artifacts a
    JOIN design_artifact_versions v ON v.id = a.current_version_id
    WHERE a.id = ?
  `).get(artifactId) as { file_path?: string } | undefined;
  if (!row?.file_path) return "";
  return fs.readFileSync(row.file_path, "utf8");
}

export function getDesignBootstrap() {
  const projects = listDesignProjects();
  const recentArtifacts = listRecentDesignArtifacts(10);
  const db = getSqlite();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM design_projects) AS projects,
      (SELECT COUNT(*) FROM design_artifacts) AS artifacts,
      (SELECT COUNT(*) FROM design_artifacts WHERE updated_at >= date('now')) AS updatedToday
  `).get() as { projects: number; artifacts: number; updatedToday: number };
  return { projects, recentArtifacts, counts };
}

export function recordDesignValidationReport(params: {
  artifactId: string;
  versionId: string;
  report: unknown;
}) {
  const reportId = genericId("desval");
  const now = nowIso();
  withSqliteWriteRecovery("design-validation:record", (db) => {
    db.prepare(`
      INSERT INTO design_validation_reports (id, artifact_id, version_id, report_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(reportId, params.artifactId, params.versionId, JSON.stringify(params.report ?? {}), now);
  });
  return getSqlite().prepare(`
    SELECT id, artifact_id, version_id, report_json, created_at
    FROM design_validation_reports
    WHERE id = ?
  `).get(reportId);
}

export function listDesignValidationReports(artifactId: string, limit = 10) {
  const rows = getSqlite().prepare(`
    SELECT id, artifact_id, version_id, report_json, created_at
    FROM design_validation_reports
    WHERE artifact_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(artifactId, Math.max(1, Math.min(50, limit)));
  return rows.map((row: any) => ({
    id: row.id,
    artifactId: row.artifact_id,
    versionId: row.version_id,
    report: JSON.parse(row.report_json || "{}"),
    createdAt: row.created_at,
  }));
}

function extractDesignSystemFacts(input: { designMd: string; tokensCss?: string | null; componentsHtml?: string | null }) {
  const text = `${input.designMd}\n${input.tokensCss || ""}\n${input.componentsHtml || ""}`;
  const colors = Array.from(text.matchAll(/(--[a-z0-9-]*?(?:color|bg|text|accent|surface)[a-z0-9-]*|#[a-z0-9]{3,8})\s*:?\s*(#[a-f0-9]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/gi))
    .slice(0, 24)
    .map((match, index) => ({ name: match[1] || `color-${index + 1}`, value: match[2] || match[1] }));
  const fonts = Array.from(text.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)).slice(0, 8).map((match, index) => ({ role: `font-${index + 1}`, stack: match[1].trim() }));
  const radii = Array.from(new Set(Array.from(text.matchAll(/border-radius\s*:\s*([^;}\n]+)/gi)).map((match) => match[1].trim()).slice(0, 12)));
  const spacing = Array.from(new Set(Array.from(text.matchAll(/(?:spacing|gap|padding|margin)[-a-z0-9]*\s*:\s*([^;}\n]+)/gi)).map((match) => match[1].trim()).slice(0, 16)));
  return { colors, fonts, radii, spacing };
}

export function listDesignSystems() {
  const rows = getSqlite().prepare(`
    SELECT id, name, category, description, status, created_at, updated_at
    FROM design_systems
    WHERE status != 'deleted'
    ORDER BY category, name
  `).all();
  return rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    category: row.category ?? null,
    description: row.description ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getDesignSystem(idValue: string) {
  const row = getSqlite().prepare(`
    SELECT id, name, category, description, design_md, tokens_css, components_html, source_json, status, created_at, updated_at
    FROM design_systems
    WHERE id = ?
  `).get(idValue) as any;
  if (!row) return null;
  const detail = {
    id: row.id,
    name: row.name,
    category: row.category ?? null,
    description: row.description ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    designMd: row.design_md,
    tokensCss: row.tokens_css ?? null,
    componentsHtml: row.components_html ?? null,
    source: JSON.parse(row.source_json || "{}"),
    extracted: extractDesignSystemFacts({
      designMd: row.design_md,
      tokensCss: row.tokens_css ?? null,
      componentsHtml: row.components_html ?? null,
    }),
  };
  return detail;
}

export function createDesignSystem(input: {
  name: string;
  category?: string | null;
  description?: string | null;
  designMd: string;
  tokensCss?: string | null;
  componentsHtml?: string | null;
  source?: unknown;
}) {
  const systemId = genericId("dessys");
  const now = nowIso();
  const name = String(input.name || "").trim();
  const designMd = String(input.designMd || "").trim();
  if (!name) throw new Error("Design system name is required");
  if (!designMd) throw new Error("Design system DESIGN.md content is required");
  withSqliteWriteRecovery("design-system:create", (db) => {
    db.prepare(`
      INSERT INTO design_systems
        (id, name, category, description, design_md, tokens_css, components_html, source_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      systemId,
      name,
      input.category ?? null,
      input.description ?? null,
      designMd,
      input.tokensCss ?? null,
      input.componentsHtml ?? null,
      JSON.stringify(input.source ?? {}),
      now,
      now,
    );
  });
  return getDesignSystem(systemId)!;
}
