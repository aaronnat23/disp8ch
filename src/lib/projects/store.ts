import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import type { ConnectedProject, ProjectEdge, ProjectFile, ProjectImpactReport, ProjectSymbol } from "./types";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value || "")) as T; } catch { return fallback; } };

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS connected_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_root TEXT NOT NULL UNIQUE,
      read_only INTEGER NOT NULL DEFAULT 1, default_branch TEXT, language_summary_json TEXT NOT NULL DEFAULT '{}',
      last_scan_commit TEXT, last_scan_at TEXT, work_trail_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, relative_path TEXT NOT NULL, language TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, content_sha256 TEXT NOT NULL, indexed_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(project_id) REFERENCES connected_projects(id) ON DELETE CASCADE, UNIQUE(project_id, relative_path)
    );
    CREATE TABLE IF NOT EXISTS project_symbols (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, file_id TEXT NOT NULL, symbol_type TEXT NOT NULL, name TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, summary TEXT, content_sha256 TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES connected_projects(id) ON DELETE CASCADE, FOREIGN KEY(file_id) REFERENCES project_files(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_edges (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, edge_type TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(project_id) REFERENCES connected_projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_impact_reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, base_ref TEXT, head_ref TEXT, changed_files_json TEXT NOT NULL,
      affected_nodes_json TEXT NOT NULL, summary_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES connected_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_project_symbols_project ON project_symbols(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_project_edges_project ON project_edges(project_id, source_id, target_id);
  `);
  return db;
}

function mapProject(row: Row): ConnectedProject {
  return { id: String(row.id), name: String(row.name), canonicalRoot: String(row.canonical_root), readOnly: Number(row.read_only) === 1,
    defaultBranch: row.default_branch ? String(row.default_branch) : null, languageSummary: parse(row.language_summary_json, {}),
    lastScanCommit: row.last_scan_commit ? String(row.last_scan_commit) : null, lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
    workTrailId: row.work_trail_id ? String(row.work_trail_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function mapFile(row: Row): ProjectFile { return { id: String(row.id), projectId: String(row.project_id), relativePath: String(row.relative_path), language: String(row.language), sizeBytes: Number(row.size_bytes), contentSha256: String(row.content_sha256), indexedAt: String(row.indexed_at), metadata: parse(row.metadata_json, {}) }; }
function mapSymbol(row: Row): ProjectSymbol { return { id: String(row.id), projectId: String(row.project_id), fileId: String(row.file_id), symbolType: String(row.symbol_type), name: String(row.name), startLine: Number(row.start_line), endLine: Number(row.end_line), signature: row.signature ? String(row.signature) : null, summary: row.summary ? String(row.summary) : null, contentSha256: String(row.content_sha256) }; }
function mapEdge(row: Row): ProjectEdge { return { id: String(row.id), projectId: String(row.project_id), sourceType: String(row.source_type), sourceId: String(row.source_id), targetType: String(row.target_type), targetId: String(row.target_id), edgeType: String(row.edge_type) as ProjectEdge["edgeType"], confidence: Number(row.confidence), evidence: parse(row.evidence_json, {}) }; }
function mapImpact(row: Row): ProjectImpactReport { return { id: String(row.id), projectId: String(row.project_id), baseRef: row.base_ref ? String(row.base_ref) : null, headRef: row.head_ref ? String(row.head_ref) : null, changedFiles: parse(row.changed_files_json, []), affectedNodes: parse(row.affected_nodes_json, []), summary: parse(row.summary_json, {}), createdAt: String(row.created_at) }; }

export function createConnectedProject(input: { name: string; canonicalRoot: string; defaultBranch?: string | null; workTrailId?: string | null }): ConnectedProject {
  const db = ensureTables(); const now = new Date().toISOString(); const id = `project_${nanoid(16)}`;
  db.prepare("INSERT INTO connected_projects(id,name,canonical_root,read_only,default_branch,language_summary_json,last_scan_commit,last_scan_at,work_trail_id,created_at,updated_at) VALUES(?,?,?,1,?,'{}',NULL,NULL,?,?,?)")
    .run(id, input.name.trim().slice(0, 200), input.canonicalRoot, input.defaultBranch || null, input.workTrailId || null, now, now);
  return getConnectedProject(id)!;
}
export function listConnectedProjects(): ConnectedProject[] { return (ensureTables().prepare("SELECT * FROM connected_projects ORDER BY updated_at DESC").all() as Row[]).map(mapProject); }
export function getConnectedProject(id: string): ConnectedProject | null { const row = ensureTables().prepare("SELECT * FROM connected_projects WHERE id=?").get(id) as Row | undefined; return row ? mapProject(row) : null; }
export function deleteConnectedProject(id: string): boolean { return ensureTables().prepare("DELETE FROM connected_projects WHERE id=?").run(id).changes > 0; }
export function updateProjectScan(id: string, input: { languageSummary: Record<string, number>; commit: string | null }): void { const now = new Date().toISOString(); ensureTables().prepare("UPDATE connected_projects SET language_summary_json=?,last_scan_commit=?,last_scan_at=?,updated_at=? WHERE id=?").run(JSON.stringify(input.languageSummary), input.commit, now, now, id); }
export function listProjectFiles(projectId: string): ProjectFile[] { return (ensureTables().prepare("SELECT * FROM project_files WHERE project_id=? ORDER BY relative_path").all(projectId) as Row[]).map(mapFile); }
export function getProjectFile(projectId: string, relativePath: string): ProjectFile | null { const row = ensureTables().prepare("SELECT * FROM project_files WHERE project_id=? AND relative_path=?").get(projectId, relativePath) as Row | undefined; return row ? mapFile(row) : null; }
export function upsertProjectFile(input: Omit<ProjectFile, "id"> & { id?: string }): ProjectFile { const db=ensureTables(); const prior=getProjectFile(input.projectId,input.relativePath); const id=prior?.id||input.id||`pfile_${nanoid(16)}`; db.prepare(`INSERT INTO project_files(id,project_id,relative_path,language,size_bytes,content_sha256,indexed_at,metadata_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,relative_path) DO UPDATE SET language=excluded.language,size_bytes=excluded.size_bytes,content_sha256=excluded.content_sha256,indexed_at=excluded.indexed_at,metadata_json=excluded.metadata_json`).run(id,input.projectId,input.relativePath,input.language,input.sizeBytes,input.contentSha256,input.indexedAt,JSON.stringify(input.metadata)); return getProjectFile(input.projectId,input.relativePath)!; }
export function deleteMissingProjectFiles(projectId: string, paths: string[]): void { const db=ensureTables(); if (!paths.length) { db.prepare("DELETE FROM project_files WHERE project_id=?").run(projectId); return; } const marks=paths.map(()=>"?").join(","); db.prepare(`DELETE FROM project_files WHERE project_id=? AND relative_path NOT IN (${marks})`).run(projectId,...paths); }
export function replaceFileSymbols(projectId: string, fileId: string, symbols: Array<Omit<ProjectSymbol,"id"|"projectId"|"fileId">>): void { const db=ensureTables(); const tx=db.transaction(()=>{ db.prepare("DELETE FROM project_symbols WHERE project_id=? AND file_id=?").run(projectId,fileId); const stmt=db.prepare("INSERT INTO project_symbols(id,project_id,file_id,symbol_type,name,start_line,end_line,signature,summary,content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)"); for(const s of symbols) stmt.run(`psym_${nanoid(16)}`,projectId,fileId,s.symbolType,s.name,s.startLine,s.endLine,s.signature,s.summary,s.contentSha256); }); tx(); }
export function listProjectSymbols(projectId: string): ProjectSymbol[] { return (ensureTables().prepare("SELECT * FROM project_symbols WHERE project_id=? ORDER BY file_id,start_line").all(projectId) as Row[]).map(mapSymbol); }
export function replaceProjectEdges(projectId: string, edges: Array<Omit<ProjectEdge,"id"|"projectId">>): void { const db=ensureTables(); const tx=db.transaction(()=>{ db.prepare("DELETE FROM project_edges WHERE project_id=?").run(projectId); const stmt=db.prepare("INSERT INTO project_edges(id,project_id,source_type,source_id,target_type,target_id,edge_type,confidence,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)"); for(const e of edges) stmt.run(`pedge_${nanoid(16)}`,projectId,e.sourceType,e.sourceId,e.targetType,e.targetId,e.edgeType,e.confidence,JSON.stringify(e.evidence)); }); tx(); }
export function listProjectEdges(projectId: string): ProjectEdge[] { return (ensureTables().prepare("SELECT * FROM project_edges WHERE project_id=?").all(projectId) as Row[]).map(mapEdge); }
export function createImpactReport(input: Omit<ProjectImpactReport,"id"|"createdAt">): ProjectImpactReport { const db=ensureTables(); const id=`impact_${nanoid(16)}`; const now=new Date().toISOString(); db.prepare("INSERT INTO project_impact_reports(id,project_id,base_ref,head_ref,changed_files_json,affected_nodes_json,summary_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,input.projectId,input.baseRef,input.headRef,JSON.stringify(input.changedFiles),JSON.stringify(input.affectedNodes),JSON.stringify(input.summary),now); return getImpactReport(id)!; }
export function getImpactReport(id:string): ProjectImpactReport|null { const row=ensureTables().prepare("SELECT * FROM project_impact_reports WHERE id=?").get(id) as Row|undefined; return row?mapImpact(row):null; }
export function listImpactReports(projectId:string): ProjectImpactReport[] { return (ensureTables().prepare("SELECT * FROM project_impact_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 30").all(projectId) as Row[]).map(mapImpact); }
