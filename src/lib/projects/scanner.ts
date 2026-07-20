import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import ignore, { type Ignore } from "ignore";
import { appendWorkTrailEvent, createWorkTrail } from "@/lib/work-trails/work-trails";
import {
  createConnectedProject, deleteMissingProjectFiles, getConnectedProject, getProjectFile, listProjectEdges,
  listProjectFiles, listProjectSymbols, replaceFileSymbols, replaceProjectEdges, updateProjectScan, upsertProjectFile,
} from "./store";
import type { ConnectedProject, ProjectEdge, ProjectFile, ProjectSymbol } from "./types";

const execFileAsync = promisify(execFile);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEXT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json", ".md", ".css", ".html", ".yml", ".yaml", ".toml", ".py", ".go", ".rs", ".java"]);
const BLOCKED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", "vendor", "__pycache__"]);
const SECRET_NAMES = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.json|.*\.(?:pem|key|p12|pfx|jks))$/i;
const SECRET_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b)/;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 50_000_000;
const MAX_FILES = 10_000;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ignoreMatcher(root: string): Promise<Ignore> {
  const matcher = ignore();
  for (const name of [".gitignore", ".disp8chignore"]) {
    try {
      const content = await fs.readFile(path.join(root, name), "utf8");
      matcher.add(content);
    } catch { /* optional */ }
  }
  return matcher;
}

function languageFor(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  return ({ ".ts": "TypeScript", ".tsx": "TypeScript JSX", ".js": "JavaScript", ".jsx": "JavaScript JSX", ".mjs": "JavaScript", ".cjs": "JavaScript", ".json": "JSON", ".md": "Markdown", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".css": "CSS", ".html": "HTML" } as Record<string,string>)[ext] || ext.slice(1).toUpperCase();
}

function lineOf(source: ts.SourceFile, position: number): number { return source.getLineAndCharacterOfPosition(position).line + 1; }

function parseSource(relativePath: string, content: string, hash: string): {
  imports: Array<{ specifier: string; line: number }>;
  exports: string[];
  symbols: Array<Omit<ProjectSymbol,"id"|"projectId"|"fileId">>;
} {
  const kind = relativePath.endsWith("x") ? ts.ScriptKind.TSX : relativePath.endsWith(".ts") ? ts.ScriptKind.TS : relativePath.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, kind);
  const imports: Array<{ specifier: string; line: number }> = [];
  const exports: string[] = [];
  const symbols: Array<Omit<ProjectSymbol,"id"|"projectId"|"fileId">> = [];
  const add = (node: ts.Node, symbolType: string, nameNode?: ts.Node, signature?: string) => {
    const name = nameNode?.getText(source).trim() || "default";
    symbols.push({ symbolType, name: name.slice(0,300), startLine: lineOf(source,node.getStart(source)), endLine: lineOf(source,node.getEnd()), signature: signature?.replace(/\s+/g," ").slice(0,1000)||null, summary:null, contentSha256:hash });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ specifier: node.moduleSpecifier.text, line: lineOf(source,node.getStart(source)) });
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ specifier: node.moduleSpecifier.text, line: lineOf(source,node.getStart(source)) });
      node.exportClause?.forEachChild((child) => exports.push(child.getText(source)));
    } else if (ts.isFunctionDeclaration(node)) add(node,"function",node.name,node.getText(source).split("{")[0]);
    else if (ts.isClassDeclaration(node)) add(node,"class",node.name,node.getText(source).split("{")[0]);
    else if (ts.isInterfaceDeclaration(node)) add(node,"interface",node.name,node.getText(source).split("{")[0]);
    else if (ts.isTypeAliasDeclaration(node)) add(node,"type",node.name,node.getText(source).split("=")[0]);
    else if (ts.isEnumDeclaration(node)) add(node,"enum",node.name,node.getText(source).split("{")[0]);
    else if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) add(declaration,"function",declaration.name,declaration.getText(source).split("=>")[0]);
    }
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && "name" in node && (node as {name?:ts.Node}).name) exports.push((node as {name:ts.Node}).name.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, exports: [...new Set(exports)], symbols };
}

async function git(root: string, args: string[]): Promise<string | null> {
  try { const result = await execFileAsync("git", args, { cwd: root, timeout: 10_000, windowsHide: true, maxBuffer: 2_000_000 }); return result.stdout.replace(/\s+$/, ""); } catch { return null; }
}

export async function connectProject(input: { root: string; name?: string; confirmed: boolean; workTrailId?: string | null }): Promise<ConnectedProject> {
  if (!input.confirmed) throw new Error("Connecting a repository root requires explicit confirmation.");
  if (!path.isAbsolute(input.root)) throw new Error("Project root must be an absolute path.");
  const canonical = await fs.realpath(path.resolve(input.root));
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error("Project root must be a directory.");
  if (path.parse(canonical).root === canonical || canonical === await fs.realpath(os.homedir())) throw new Error("Filesystem and user-home roots cannot be connected.");
  const branch = await git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const idSeed = crypto.createHash("sha256").update(canonical).digest("hex").slice(0,16);
  const trailId = input.workTrailId || createWorkTrail({ userMessage: `Connect project ${input.name || path.basename(canonical)}`, intent: { kind:"connect_project", canonicalRootHash:idSeed }, status:"executing" });
  const project = createConnectedProject({ name: input.name || path.basename(canonical), canonicalRoot: canonical, defaultBranch: branch, workTrailId: trailId });
  if (trailId) appendWorkTrailEvent({ trailId, eventType:"project_attached", surface:"files", objectType:"project", objectId:project.id, objectName:project.name, summary:"Read-only repository connected" });
  return project;
}

export async function scanProject(projectId: string): Promise<{ project: ConnectedProject; files: ProjectFile[]; symbols: ProjectSymbol[]; edges: ProjectEdge[]; changed: number; warnings: string[] }> {
  const project = getConnectedProject(projectId); if (!project) throw new Error("Connected project not found.");
  const canonicalRoot = await fs.realpath(project.canonicalRoot); if (canonicalRoot !== project.canonicalRoot) throw new Error("Connected root canonical path changed; reconnect it.");
  const matcher = await ignoreMatcher(canonicalRoot); const found: Array<{relativePath:string;absolutePath:string;size:number}> = []; const warnings:string[]=[];
  let total=0;
  const walk = async (directory:string):Promise<void> => {
    const entries = await fs.readdir(directory,{withFileTypes:true});
    for(const entry of entries){
      if(found.length>=MAX_FILES || total>=MAX_TOTAL_BYTES) return;
      if(entry.isSymbolicLink()) { warnings.push(`Skipped symlink: ${path.relative(canonicalRoot,path.join(directory,entry.name)).replace(/\\/g,"/")}`); continue; }
      const absolutePath=path.join(directory,entry.name); const relativePath=path.relative(canonicalRoot,absolutePath).replace(/\\/g,"/");
      if(!inside(canonicalRoot,absolutePath) || matcher.ignores(entry.isDirectory() ? `${relativePath}/` : relativePath)) continue;
      if(entry.isDirectory()){ if(BLOCKED_DIRS.has(entry.name)||entry.name.startsWith(".cache")) continue; await walk(absolutePath); continue; }
      if(!entry.isFile() || SECRET_NAMES.test(entry.name) || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat=await fs.stat(absolutePath); if(stat.size>MAX_FILE_BYTES){warnings.push(`Skipped oversized file: ${relativePath}`);continue;} if(total+stat.size>MAX_TOTAL_BYTES) {warnings.push("Project scan reached the 50 MB text limit.");return;}
      const real=await fs.realpath(absolutePath); if(!inside(canonicalRoot,real)){warnings.push(`Skipped path escape: ${relativePath}`);continue;} total+=stat.size; found.push({relativePath,absolutePath:real,size:stat.size});
    }
  };
  await walk(canonicalRoot);
  let changed=0; const now=new Date().toISOString(); const languageSummary:Record<string,number>={};
  for(const item of found){
    const content=await fs.readFile(item.absolutePath,"utf8");
    if (SECRET_CONTENT.test(content)) { warnings.push(`Skipped possible embedded secret: ${item.relativePath}`); continue; }
    const hash=crypto.createHash("sha256").update(content).digest("hex"); const prior=getProjectFile(projectId,item.relativePath); const language=languageFor(item.relativePath); languageSummary[language]=(languageSummary[language]||0)+1;
    if(prior?.contentSha256===hash) continue;
    changed++;
    const parsed=SOURCE_EXTENSIONS.has(path.extname(item.relativePath).toLowerCase())?parseSource(item.relativePath,content,hash):{imports:[],exports:[],symbols:[]};
    const file=upsertProjectFile({projectId,relativePath:item.relativePath,language,sizeBytes:item.size,contentSha256:hash,indexedAt:now,metadata:{imports:parsed.imports,exports:parsed.exports}});
    replaceFileSymbols(projectId,file.id,parsed.symbols);
  }
  deleteMissingProjectFiles(projectId,found.map((item)=>item.relativePath));
  const files=listProjectFiles(projectId); const pathMap=new Map(files.map((file)=>[file.relativePath,file])); const edges:Array<Omit<ProjectEdge,"id"|"projectId">>=[];
  const resolveImport=(sourcePath:string,specifier:string):ProjectFile|null=>{ if(!specifier.startsWith(".")) return null; const base=path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath),specifier)); for(const candidate of [base,...[".ts",".tsx",".js",".jsx",".mjs",".cjs"].map((ext)=>base+ext),...["/index.ts","/index.tsx","/index.js","/index.jsx"].map((suffix)=>base+suffix)]){const file=pathMap.get(candidate);if(file)return file;} return null; };
  for(const file of files) for(const item of file.metadata.imports||[]){ const target=resolveImport(file.relativePath,item.specifier); if(target) edges.push({sourceType:"file",sourceId:file.id,targetType:"file",targetId:target.id,edgeType:"imports",confidence:1,evidence:{sourcePath:file.relativePath,targetPath:target.relativePath,line:item.line,specifier:item.specifier}}); }
  replaceProjectEdges(projectId,edges); const commit=await git(canonicalRoot,["rev-parse","HEAD"]); updateProjectScan(projectId,{languageSummary,commit});
  if(project.workTrailId) appendWorkTrailEvent({trailId:project.workTrailId,eventType:"object_linked",surface:"files",objectType:"project-scan",objectId:projectId,summary:`${files.length} files, ${changed} changed, ${edges.length} import edges`});
  return {project:getConnectedProject(projectId)!,files,symbols:listProjectSymbols(projectId),edges:listProjectEdges(projectId),changed,warnings};
}

export async function readConnectedProjectFile(projectId:string,relativePath:string):Promise<{content:string;file:ProjectFile}> {
  const project=getConnectedProject(projectId); const file=getProjectFile(projectId,relativePath); if(!project||!file) throw new Error("Indexed project file not found.");
  if(relativePath.includes("\0")||path.isAbsolute(relativePath)) throw new Error("Invalid project-relative path.");
  const target=await fs.realpath(path.resolve(project.canonicalRoot,relativePath)); if(!inside(project.canonicalRoot,target)) throw new Error("Project path escape blocked.");
  const stat=await fs.stat(target); if(!stat.isFile()||stat.size>MAX_FILE_BYTES) throw new Error("Project file is not readable.");
  const content=await fs.readFile(target,"utf8"); const hash=crypto.createHash("sha256").update(content).digest("hex"); if(hash!==file.contentSha256) throw new Error("File changed since the last scan. Rescan before reading it.");
  return {content,file};
}

export { git as runProjectGit };
