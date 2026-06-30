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
  supportFiles?: Array<{ path: string; content: string }>;
  verification?: { passed: boolean; checks: string[] } | null;
};

const PROPOSAL_DIR = path.join(WORKSPACE_PATH, "self-improvement-proposals");

function proposalPath(id: string): string {
  return path.join(PROPOSAL_DIR, `${id}.json`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
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
    supportFiles: input.supportFiles ?? undefined,
    verification: input.verification ?? null,
  };
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  fs.writeFileSync(proposalPath(proposal.id), JSON.stringify(proposal, null, 2) + "\n", "utf8");
  if (proposal.kind === "skill") {
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
  }
  return proposal;
}

export function listSelfImprovementProposals(): SelfImprovementProposal[] {
  if (!fs.existsSync(PROPOSAL_DIR)) return [];
  return fs.readdirSync(PROPOSAL_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, name), "utf8")) as SelfImprovementProposal;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SelfImprovementProposal => Boolean(entry))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getSelfImprovementProposal(id: string): SelfImprovementProposal | null {
  const cleanId = String(id || "").trim();
  if (!cleanId || cleanId.includes("/") || cleanId.includes("\\")) return null;
  const filePath = proposalPath(cleanId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as SelfImprovementProposal;
  } catch {
    return null;
  }
}

function saveProposal(proposal: SelfImprovementProposal): SelfImprovementProposal {
  const next = { ...proposal, updatedAt: new Date().toISOString() };
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  fs.writeFileSync(proposalPath(next.id), JSON.stringify(next, null, 2) + "\n", "utf8");
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
  }
  return updated;
}

export function applySelfImprovementProposal(id: string): SelfImprovementProposal {
  const proposal = getSelfImprovementProposal(id);
  if (!proposal) throw new Error(`Self-improvement proposal not found: ${id}`);
  if (proposal.status === "applied") return proposal;

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
    const scan = scanSkillContent(proposal.proposedContent);
    if (!scan.safe) {
      throw new Error(`Skill proposal blocked by security scan: ${scan.threats.join(", ")}`);
    }
    const workspaceDir = getWorkspaceDir();
    ensureWorkspaceScaffold({ workspacePath: workspaceDir });
    const skillDir = path.join(workspaceDir, "skills", `proposed-${slugify(proposal.title) || proposal.id}`);
    fs.mkdirSync(skillDir, { recursive: true });
    appliedPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(appliedPath, `${proposal.proposedContent.trimEnd()}\n`, "utf8");
    // Support files for source-learned skills (references/templates/scripts/tests).
    if (Array.isArray(proposal.supportFiles)) {
      for (const file of proposal.supportFiles) {
        const safeRel = String(file.path || "")
          .replace(/\\/g, "/")
          .replace(/\.\.+/g, "")
          .replace(/^\/+/, "")
          .trim();
        if (!safeRel || safeRel.includes("..")) continue;
        const target = path.resolve(skillDir, safeRel);
        if (!target.startsWith(path.resolve(skillDir))) continue;
        const scan = scanSkillContent(file.content);
        if (!scan.safe) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${String(file.content).trimEnd()}\n`, "utf8");
      }
    }
    fs.writeFileSync(
      path.join(skillDir, "proposal.json"),
      `${JSON.stringify(
        {
          id: proposal.id,
          sessionId: proposal.sessionId,
          title: proposal.title,
          rationale: proposal.rationale,
          evidence: proposal.evidence,
          sourcePackId: proposal.sourcePackId ?? null,
          compileRunId: proposal.compileRunId ?? null,
          verification: proposal.verification ?? null,
          appliedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } else {
    const workspaceDir = getWorkspaceDir();
    ensureWorkspaceScaffold({ workspacePath: workspaceDir });
    const dir = path.join(workspaceDir, "self-improvement-applied");
    fs.mkdirSync(dir, { recursive: true });
    appliedPath = path.join(dir, `${proposal.kind}-${slugify(proposal.title) || proposal.id}.md`);
    fs.writeFileSync(
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
      "utf8",
    );
  }

  const applied = saveProposal({ ...proposal, status: "applied", appliedPath });
  if (proposal.kind === "skill") {
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
  }
  return applied;
}
