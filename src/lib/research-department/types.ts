// Shared types for the Research Department template pack.
//
// A "research department" is a thin grouping object over real, editable disp8ch
// objects: agents, workflows, schedules, and a local markdown vault. Nothing in
// here is hidden automation — every field maps to inspectable app state.

export type ResearchDepartmentTier = "basic" | "standard" | "advanced";

export type ResearchDepartmentRole = "scout" | "analyst" | "briefer";

export type ResearchDepartmentWorkflowKind =
  | "scout_web"
  | "scout_rss"
  | "scout_arxiv"
  | "scout_competitor_diff"
  | "analyst_inbox"
  | "analyst_weekly_synthesis"
  | "briefer_morning";

export interface ResearchSourceConfig {
  /** Free-text keywords / niche used to seed Scout prompts and queries. */
  keywords: string[];
  /** RSS / Atom feed URLs the Scout RSS workflow polls. */
  rssFeeds: string[];
  /** arXiv category codes or full feed URLs (e.g. "cs.AI"). */
  arxivCategories: string[];
  /** Competitor / launch page URLs for the diff workflow (advanced tier). */
  competitorUrls: string[];
}

export interface ResearchDeliveryConfig {
  /** Channel kind the Briefer delivers to. Defaults to webchat. */
  channel: "webchat" | "telegram" | "slack" | "discord";
  /** Optional channel id / record reference when a real channel is configured. */
  channelId?: string | null;
}

export interface ResearchModelConfig {
  /** Model ref for the Scout agent (cheap/fast). */
  scout?: string | null;
  /** Model ref for the Analyst agent (strongest configured). */
  analyst?: string | null;
  /** Model ref for the Briefer agent (cheap/fast). */
  briefer?: string | null;
}

export interface ResearchSafetyConfig {
  /** Per-run token budget warning threshold. */
  perRunTokenCap: number;
  /** Max source items captured per Scout run. */
  maxSourcesPerRun: number;
  /** When true, generated workflows never include delete operations. */
  noDelete: boolean;
  /** Optional MCP server name scoped to the Analyst only (advanced tier). */
  analystMcpServer?: string | null;
}

export interface CreateResearchDepartmentInput {
  name: string;
  tier: ResearchDepartmentTier;
  focusArea: string;
  sources: ResearchSourceConfig;
  delivery?: ResearchDeliveryConfig;
  models?: ResearchModelConfig;
  safety?: Partial<ResearchSafetyConfig>;
  /** Optional explicit vault root. When omitted a default slug path is used. */
  vaultRoot?: string;
  /** Must be true to allow a vault path outside the default workspace root. */
  allowCustomVaultPath?: boolean;
  /** Skip activating (and scheduling) workflows on create. */
  inactive?: boolean;
}

export interface ResearchDepartmentMember {
  departmentId: string;
  agentId: string;
  role: ResearchDepartmentRole;
}

export interface ResearchDepartmentWorkflowLink {
  departmentId: string;
  workflowId: string;
  kind: ResearchDepartmentWorkflowKind;
}

export interface ResearchDepartmentRecord {
  id: string;
  name: string;
  slug: string;
  tier: ResearchDepartmentTier;
  focusArea: string;
  keywords: string[];
  sourceConfig: ResearchSourceConfig;
  vaultRoot: string;
  deliveryConfig: ResearchDeliveryConfig;
  safetyConfig: ResearchSafetyConfig;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchDepartmentDetail extends ResearchDepartmentRecord {
  members: ResearchDepartmentMember[];
  workflows: ResearchDepartmentWorkflowLink[];
}

export const RESEARCH_DEPARTMENT_SOURCE_TYPE = "research-department";

export const DEFAULT_RESEARCH_SAFETY: ResearchSafetyConfig = {
  perRunTokenCap: 60_000,
  maxSourcesPerRun: 25,
  noDelete: true,
  analystMcpServer: null,
};
