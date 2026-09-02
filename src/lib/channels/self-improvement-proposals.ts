import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scanLearningWrite } from "@/lib/learning/memory-guard";
import { scanSkillContent } from "@/lib/learning/skill-guard";
import {
  WORKSPACE_PATH,
  appendMainMemoryNote,
  ensureWorkspaceScaffold,
  getWorkspaceDir,
} from "@/lib/workspace/files";
import { recordSkillUsageEvent } from "@/lib/skills/usage-ledger";
import {
  deleteSkillFileRevision,
  recordSkillFileRevision,
  skillContentHash,
} from "@/lib/skills/version-history";
import { assertCanonicalPathInsideRoot } from "@/lib/security/path-safety";

export type SkillProposalOperation = "new" | "patch" | "support";

export type SelfImprovementProposal = {
  id: string;
  sessionId: string;
  kind: "memory" | "skill" | "prompt_rule" | "test_case";
  title: string;
  rationale: string;
  proposedContent: string;
  evidence: string[];
  status: "pending" | "approved" | "rejected" | "applied";
  createdAt: string;
  updatedAt?: string;
  appliedPath?: string | null;
  /** Set for source-to-skill learned skills: provenance + verification. */
  sourcePackId?: string | null;
  compileRunId?: string | null;
  skillOperation?: SkillProposalOperation | null;
  targetSkillPath?: string | null;
  targetContentHash?: string | null;
  proposedSlug?: string | null;
  updatesSkillContent?: boolean;
  supportFiles?: Array<{ path: string; content: string }>;
  verification?: { passed: boolean; checks: string[] } | null;
};

const PROPOSAL_DIR = path.join(WORKSPACE_PATH, "self-improvement-proposals");
const MAX_SKILL_CONTENT_BYTES = 1_000_000;
const MAX_PROPOSAL_FILE_BYTES = 4_000_000;
const ALLOWED_SUPPORT_FOLDERS = new Set(["references", "templates", "scripts", "tests"]);

function proposalPath(id: string): string {
  const cleanId = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(cleanId)) throw new Error("Invalid self-improvement proposal ID");
  return path.join(PROPOSAL_DIR, `${cleanId}.json`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
  }
}

function assertRegularUnlinkedFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error(`${label} must be a regular, non-linked file`);
  }
  if (stat.size > MAX_SKILL_CONTENT_BYTES) {
    throw new Error(`${label} exceeds the 1 MB safety limit`);
  }
}

export function resolveWorkspaceSkillTarget(targetSkillPath: string): {
  skillPath: string;
  content: string;
  contentHash: string;
} {
  const workspaceDir = getWorkspaceDir();
  const skillsRoot = path.join(workspaceDir, "skills");
  const raw = String(targetSkillPath || "").trim();
  if (!raw) throw new Error("A workspace skill target is required");

  let candidate = path.isAbsolute(raw)
    ? raw
    : path.resolve(workspaceDir, raw.replace(/^[\\/]+/, ""));
  if (path.basename(candidate).toLowerCase() !== "skill.md") {
    candidate = path.join(candidate, "SKILL.md");
  }
  const skillPath = assertCanonicalPathInsideRoot(candidate, skillsRoot);
  if (!fs.existsSync(skillPath)) throw new Error(`Target workspace skill does not exist: ${raw}`);
  assertRegularUnlinkedFile(skillPath, "Target SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");
  return { skillPath, content, contentHash: skillContentHash(content) };
}

function resolveNewSkillPath(proposal: SelfImprovementProposal): string {
  const workspaceDir = getWorkspaceDir();
  const skillsRoot = path.join(workspaceDir, "skills");
  const slug = slugify(proposal.proposedSlug || proposal.title) || proposal.id;
  return assertCanonicalPathInsideRoot(path.join(skillsRoot, slug, "SKILL.md"), skillsRoot);
}

function resolveSupportPath(skillPath: string, relativePath: string): string {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 2 || !ALLOWED_SUPPORT_FOLDERS.has(parts[0])) {
    throw new Error("Skill support files must be one file under references/, templates/, scripts/, or tests/");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(parts[1]) || parts[1] === "." || parts[1] === "..") {
    throw new Error(`Invalid skill support filename: ${parts[1] || "(empty)"}`);
  }
  const skillDir = path.dirname(skillPath);
  return assertCanonicalPathInsideRoot(path.join(skillDir, parts[0], parts[1]), skillDir);
}

function writeSkillMetadata(skillDir: string, proposal: SelfImprovementProposal): void {
  atomicWrite(
    path.join(skillDir, "proposal.json"),
    `${JSON.stringify(
      {
        id: proposal.id,
        sessionId: proposal.sessionId,
        title: proposal.title,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        skillOperation: proposal.skillOperation ?? "new",
        sourcePackId: proposal.sourcePackId ?? null,
        compileRunId: proposal.compileRunId ?? null,
        verification: proposal.verification ?? null,
        appliedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

export function automaticSelfImprovementProposalsDisabled(): boolean {
  const flags = [
    process.env.DISP8CH_DISABLE_SELF_IMPROVEMENT_PROPOSALS,
    process.env.DISP8CH_BENCHMARK_MODE,
    process.env.DISP8CH_COMPARISON_BENCHMARK,
  ];
  return flags.some((flag) => /^(1|true|yes|on)$/i.test(String(flag || "").trim()));
}

export function writeSelfImprovementProposal(
  input: Omit<SelfImprovementProposal, "id" | "status" | "createdAt" | "updatedAt" | "appliedPath"> & {
    id?: string;
    status?: SelfImprovementProposal["status"];
    appliedPath?: string | null;
  },
): SelfImprovementProposal {
  if (Buffer.byteLength(String(input.proposedContent || ""), "utf8") > MAX_SKILL_CONTENT_BYTES) {
    throw new Error("Self-improvement proposal content exceeds the 1 MB safety limit");
  }
  if ((input.supportFiles?.length ?? 0) > 20) {
    throw new Error("A self-improvement proposal can contain at most 20 support files");
  }
  const proposal: SelfImprovementProposal = {
    id: input.id || crypto.randomBytes(8).toString("hex"),
    sessionId: input.sessionId,
    kind: input.kind,
    title: input.title,
    rationale: input.rationale,
    proposedContent: input.proposedContent,
    evidence: input.evidence,
    status: input.status || "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appliedPath: input.appliedPath ?? null,
    sourcePackId: input.sourcePackId ?? null,
    compileRunId: input.compileRunId ?? null,
    skillOperation: input.skillOperation ?? null,
    targetSkillPath: input.targetSkillPath ?? null,
    targetContentHash: input.targetContentHash ?? null,
    proposedSlug: input.proposedSlug ?? null,
    updatesSkillContent: input.updatesSkillContent ?? true,
    supportFiles: input.supportFiles ?? undefined,
    verification: input.verification ?? null,
  };
  for (const file of proposal.supportFiles ?? []) {
    if (Buffer.byteLength(String(file.content || ""), "utf8") > MAX_SKILL_CONTENT_BYTES) {
      throw new Error(`Skill support file exceeds the 1 MB safety limit: ${String(file.path || "(unnamed)")}`);
    }
  }
  const serialized = JSON.stringify(proposal, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROPOSAL_FILE_BYTES) {
    throw new Error("Self-improvement proposal exceeds the 4 MB storage limit");
  }
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  const destination = proposalPath(proposal.id);
  if (fs.existsSync(destination)) throw new Error(`Self-improvement proposal already exists: ${proposal.id}`);
  atomicWrite(destination, serialized);
  if (proposal.kind === "skill") {
    try {
      recordSkillUsageEvent({
        skillName: proposal.title,
        skillSource: "workspace",
        skillCategory: "self-improvement",
        eventKind: "proposed_patch",
        sessionId: proposal.sessionId,
        triggerText: proposal.rationale,
        evidence: proposal.evidence,
        metadata: { proposalId: proposal.id, status: proposal.status },
      });
    } catch {
      // Proposal persistence is authoritative; usage telemetry is best-effort.
    }
  }
  return proposal;
}

export function listSelfImprovementProposals(): SelfImprovementProposal[] {
  if (!fs.existsSync(PROPOSAL_DIR)) return [];
  return fs.readdirSync(PROPOSAL_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        const filePath = path.join(PROPOSAL_DIR, name);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_PROPOSAL_FILE_BYTES) return null;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as SelfImprovementProposal;
        const id = path.basename(name, ".json");
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
        return { ...parsed, id };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SelfImprovementProposal => Boolean(entry))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getSelfImprovementProposal(id: string): SelfImprovementProposal | null {
  const cleanId = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(cleanId)) return null;
  const filePath = proposalPath(cleanId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_PROPOSAL_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as SelfImprovementProposal;
    return { ...parsed, id: cleanId };
  } catch {
    return null;
  }
}

function saveProposal(proposal: SelfImprovementProposal): SelfImprovementProposal {
  const next = { ...proposal, updatedAt: new Date().toISOString() };
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  atomicWrite(proposalPath(next.id), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function updateSelfImprovementProposalStatus(
  id: string,
  status: Extract<SelfImprovementProposal["status"], "approved" | "rejected">,
): SelfImprovementProposal {
  const proposal = getSelfImprovementProposal(id);
  if (!proposal) throw new Error(`Self-improvement proposal not found: ${id}`);
  if (proposal.status === "applied") return proposal;
  const updated = saveProposal({ ...proposal, status });
  if (proposal.kind === "skill" && status === "rejected") {
    try {
      recordSkillUsageEvent({
        skillName: proposal.title,
        skillSource: "workspace",
        skillCategory: "self-improvement",
        eventKind: "dismissed",
        sessionId: proposal.sessionId,
        triggerText: proposal.rationale,
        evidence: proposal.evidence,
        metadata: { proposalId: proposal.id },
      });
    } catch {
      // Status persistence is authoritative; usage telemetry is best-effort.
    }
  }
  return updated;
}

export function applySelfImprovementProposal(id: string): SelfImprovementProposal {
  const proposal = getSelfImprovementProposal(id);
  if (!proposal) throw new Error(`Self-improvement proposal not found: ${id}`);
  if (proposal.status === "applied") return proposal;
  if (proposal.status !== "approved") {
    throw new Error("Self-improvement proposal must be approved before it can be applied");
  }

  let appliedPath: string | null = null;
  if (proposal.kind === "memory") {
    const guard = scanLearningWrite("memory", proposal.proposedContent);
    if (!guard.safe) {
      throw new Error(`Memory proposal blocked by guard: ${guard.findings.map((finding) => finding.label).join(", ")}`);
    }
    appendMainMemoryNote(proposal.proposedContent, {
      id: `self-improvement:${proposal.id}`,
      source: "self-improvement-proposal",
      confidence: 0.85,
    });
    appliedPath = path.join(getWorkspaceDir(), "MEMORY.md");
  } else if (proposal.kind === "skill") {
    const workspaceDir = getWorkspaceDir();
    ensureWorkspaceScaffold({ workspacePath: workspaceDir });
    const operation = proposal.skillOperation ?? "new";
    let existingContent = "";
    if (operation === "patch" || operation === "support") {
      const target = resolveWorkspaceSkillTarget(proposal.targetSkillPath || "");
      if (!proposal.targetContentHash || target.contentHash !== proposal.targetContentHash) {
        throw new Error("Target skill changed after this proposal was created. Review and approve a fresh proposal.");
      }
      appliedPath = target.skillPath;
      existingContent = target.content;
    } else {
      appliedPath = resolveNewSkillPath(proposal);
      if (fs.existsSync(appliedPath) || fs.existsSync(path.dirname(appliedPath))) {
        throw new Error(`A workspace skill already exists at ${appliedPath}`);
      }
    }

    const nextSkillContent = `${String(proposal.proposedContent || "").trimEnd()}\n`;
    const updatesSkillContent = operation !== "support" || proposal.updatesSkillContent === true;
    if (updatesSkillContent) {
      if (Buffer.byteLength(nextSkillContent, "utf8") > MAX_SKILL_CONTENT_BYTES) {
        throw new Error("Proposed skill content exceeds the 1 MB safety limit");
      }
      const scan = scanSkillContent(nextSkillContent);
      if (!scan.safe) throw new Error(`Skill proposal blocked by security scan: ${scan.threats.join(", ")}`);
    }

    const supportTargets = new Set<string>();
    const supportWrites = (proposal.supportFiles ?? []).map((file) => {
      const target = resolveSupportPath(appliedPath!, file.path);
      if (supportTargets.has(target)) throw new Error(`Duplicate skill support file: ${file.path}`);
      supportTargets.add(target);
      if (fs.existsSync(target)) {
        throw new Error(`Support file already exists; refusing to overwrite it without version history: ${file.path}`);
      }
      const content = `${String(file.content || "").trimEnd()}\n`;
      if (Buffer.byteLength(content, "utf8") > MAX_SKILL_CONTENT_BYTES) {
        throw new Error(`Support file exceeds the 1 MB safety limit: ${file.path}`);
      }
      const scan = scanSkillContent(content);
      if (!scan.safe) throw new Error(`Skill support file blocked by security scan: ${scan.threats.join(", ")}`);
      return { target, content };
    });

    if (operation === "new") fs.mkdirSync(path.dirname(appliedPath), { recursive: true });
    let preservedRevisionId: string | null = null;
    let appliedRevisionId: string | null = null;
    let wroteSkillContent = false;
    let wroteSkillMetadata = false;
    const writtenSupportPaths: string[] = [];
    try {
      if (updatesSkillContent && existingContent !== nextSkillContent) {
        if (operation !== "new") {
          preservedRevisionId = recordSkillFileRevision({
            skillPath: appliedPath,
            content: existingContent,
            source: "proposal",
            proposalId: proposal.id,
          }).id;
        }
        atomicWrite(appliedPath, nextSkillContent);
        wroteSkillContent = true;
        appliedRevisionId = recordSkillFileRevision({
          skillPath: appliedPath,
          content: nextSkillContent,
          source: "proposal",
          proposalId: proposal.id,
        }).id;
      }
      for (const file of supportWrites) {
        atomicWrite(file.target, file.content);
        writtenSupportPaths.push(file.target);
      }
      if (operation === "new") {
        writeSkillMetadata(path.dirname(appliedPath), proposal);
        wroteSkillMetadata = true;
      }
      const applied = saveProposal({ ...proposal, status: "applied", appliedPath });
      try {
        recordSkillUsageEvent({
          skillName: proposal.title,
          skillSource: "workspace",
          skillCategory: "self-improvement",
          eventKind: "applied_patch",
          sessionId: proposal.sessionId,
          triggerText: proposal.rationale,
          evidence: proposal.evidence,
          outcome: appliedPath,
          metadata: { proposalId: proposal.id, appliedPath },
        });
      } catch {
        // Usage telemetry must not roll back an already committed proposal.
      }
      return applied;
    } catch (error) {
      if (wroteSkillMetadata) {
        try {
          const metadataPath = path.join(path.dirname(appliedPath), "proposal.json");
          if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
        } catch { /* best effort rollback */ }
      }
      for (const supportPath of writtenSupportPaths.reverse()) {
        try { if (fs.existsSync(supportPath)) fs.unlinkSync(supportPath); } catch { /* best effort rollback */ }
      }
      if (wroteSkillContent) {
        try {
          if (operation === "new") {
            if (fs.existsSync(appliedPath)) fs.unlinkSync(appliedPath);
          } else {
            atomicWrite(appliedPath, existingContent);
          }
        } catch {
          // Preserve the original failure; version history still contains the prior content.
        }
      }
      if (appliedRevisionId) deleteSkillFileRevision(appliedPath, appliedRevisionId);
      if (preservedRevisionId) deleteSkillFileRevision(appliedPath, preservedRevisionId);
      if (operation === "new") {
        const candidateDirs = [
          ...writtenSupportPaths.map((supportPath) => path.dirname(supportPath)),
          path.dirname(appliedPath),
        ].sort((left, right) => right.length - left.length);
        for (const dir of candidateDirs) {
          try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* best effort */ }
        }
      }
      throw error;
    }
  } else {
    const workspaceDir = getWorkspaceDir();
    ensureWorkspaceScaffold({ workspacePath: workspaceDir });
    const dir = path.join(workspaceDir, "self-improvement-applied");
    fs.mkdirSync(dir, { recursive: true });
    appliedPath = path.join(dir, `${proposal.kind}-${slugify(proposal.title) || proposal.id}.md`);
    atomicWrite(
      appliedPath,
      [
        `# ${proposal.title}`,
        "",
        `Kind: ${proposal.kind}`,
        `Rationale: ${proposal.rationale}`,
        "",
        proposal.proposedContent.trim(),
        "",
      ].join("\n"),
    );
  }

  return saveProposal({ ...proposal, status: "applied", appliedPath });
}
