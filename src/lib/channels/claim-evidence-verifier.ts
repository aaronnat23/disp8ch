import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { extractImportantClaims, type ExtractedClaim } from "@/lib/channels/claim-extractor";

export type ClaimEvidenceIssue = "unsupported_web_claim" | "unsupported_repo_claim" | "unsupported_verification_claim";

export type ClaimEvidenceVerification = {
  ok: boolean;
  issues: ClaimEvidenceIssue[];
  unsupported: ExtractedClaim[];
};

export function verifyClaimsAgainstEvidence(answer: string, ledger: EvidenceLedgerEntry[] = []): ClaimEvidenceVerification {
  const claims = extractImportantClaims(answer);
  const hasWeb = ledger.some((entry) => entry.verified && (entry.kind === "web_source" || entry.kind === "browser_page" || entry.kind === "document"));
  const hasRepoRead = ledger.some((entry) => entry.verified && entry.kind === "repo_file" && entry.tool === "read_file");
  const unsupported: ExtractedClaim[] = [];
  const issues = new Set<ClaimEvidenceIssue>();

  for (const claim of claims) {
    if (claim.kind === "web" && /\b(?:searched|public discussion|source|latest|current|shows|according)\b/i.test(claim.text) && !hasWeb) {
      unsupported.push(claim);
      issues.add("unsupported_web_claim");
    }
    if (claim.kind === "repo" && /\b(?:verified|confirmed|handles|routes|reads|writes|implemented|implements|because|defines|manages|enforces)\b/i.test(claim.text) && !hasRepoRead) {
      unsupported.push(claim);
      issues.add("unsupported_repo_claim");
    }
    if (claim.kind === "verification" && !hasWeb && !hasRepoRead) {
      unsupported.push(claim);
      issues.add("unsupported_verification_claim");
    }
  }

  return { ok: issues.size === 0, issues: Array.from(issues), unsupported };
}

export type LocalModelSetupClaimFamily =
  | "model_vram_fit"
  | "runtime_support"
  | "openai_compat_endpoint"
  | "integration_connection"
  | "community_risk";

export type LocalModelSetupClaimVerification = {
  ok: boolean;
  unsupportedFamilies: LocalModelSetupClaimFamily[];
  coveredFamilies: LocalModelSetupClaimFamily[];
};

const LOCAL_MODEL_SETUP_CLAIM_FAMILIES: Array<{
  family: LocalModelSetupClaimFamily;
  claimPattern: RegExp;
  requiredPurposes: string[];
}> = [
  {
    family: "model_vram_fit",
    claimPattern: /\b(?:qwen|14b|7b|1\.5b|3b|8b|vram|fits?|within|under|16\s*gb)\b[\s\S]{0,80}\b(?:vram|gb|16\s*gb|memory|context|kv\s+cache)\b/i,
    requiredPurposes: ["model_runtime"],
  },
  {
    family: "runtime_support",
    claimPattern: /\b(?:ollama|lm\s*studio|llama\.cpp|vllm|sglang)\b[\s\S]{0,80}\b(?:support|supports|works?|run|runs?|serve|serving|compatible)\b/i,
    requiredPurposes: ["model_runtime", "official_primary_product", "official_integration_product"],
  },
  {
    family: "openai_compat_endpoint",
    claimPattern: /openai.{0,20}compatible/i,
    requiredPurposes: ["model_runtime", "official_primary_product"],
  },
  {
    family: "integration_connection",
    claimPattern: /\b(?:agent|app|web\s*ui|webui|front[-\s]?end|integration|connector|provider|model\s+config)\b[\s\S]{0,80}\b(?:connect|endpoint|api|local|point|base\s*url)\b/i,
    requiredPurposes: ["official_primary_product", "official_integration_product"],
  },
  {
    family: "community_risk",
    claimPattern: /\b(?:community\s+report|users?\s+report(?:ed)?|known\s+issue|common\s+problem|forum\s+discussion)\b/i,
    requiredPurposes: ["community_report"],
  },
];

export function verifyLocalModelSetupClaimsAgainstEvidence(answer: string, ledger: EvidenceLedgerEntry[] = []): LocalModelSetupClaimVerification {
  const coveredPurposes = new Set(
    ledger
      .filter((e) => e.verified && e.metadata?.sourceKind !== "search_index")
      .map((e) => e.metadata?.sourcePurpose as string)
      .filter(Boolean),
  );

  const hasExplicitUncertainty = /could not verify|uncertain|not confirmed|unverified|unclear|inferred|inference|unknown|not fully verified/i.test(answer);

  const unsupportedFamilies: LocalModelSetupClaimFamily[] = [];
  const coveredFamilies: LocalModelSetupClaimFamily[] = [];

  for (const { family, claimPattern, requiredPurposes } of LOCAL_MODEL_SETUP_CLAIM_FAMILIES) {
    if (!claimPattern.test(answer)) continue;
    const hasSupportingEvidence = requiredPurposes.some((p) => coveredPurposes.has(p));
    if (hasSupportingEvidence || hasExplicitUncertainty) {
      coveredFamilies.push(family);
    } else {
      unsupportedFamilies.push(family);
    }
  }

  return { ok: unsupportedFamilies.length === 0, unsupportedFamilies, coveredFamilies };
}
