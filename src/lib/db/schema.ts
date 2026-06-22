import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  googleId: text("google_id").unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  nodes: text("nodes").notNull(), // JSON
  edges: text("edges").notNull(), // JSON
  sourceType: text("source_type"),
  sourceRef: text("source_ref"),
  isActive: integer("is_active").default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const executions = sqliteTable("executions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  status: text("status").notNull(), // "running" | "completed" | "failed"
  triggerType: text("trigger_type").notNull(),
  triggerData: text("trigger_data"), // JSON
  provenance: text("provenance"), // JSON
  nodeResults: text("node_results"), // JSON
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  error: text("error"),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  config: text("config").notNull(), // JSON (encrypted)
  isActive: integer("is_active").default(0),
  createdAt: text("created_at").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull(), // Encrypted
  priority: integer("priority").default(0),
  isActive: integer("is_active").default(1),
  maxTokens: integer("max_tokens"),
  createdAt: text("created_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  name: text("name").notNull(),
  secret: text("secret").notNull(),
  isActive: integer("is_active").default(1),
  createdAt: text("created_at").notNull(),
});

export const appConfig = sqliteTable("app_config", {
  id: text("id").primaryKey(), // always "default"
  onboardingDone: integer("onboarding_done").default(0),
  timezone: text("timezone").default("UTC"),
  learningEnabled: integer("learning_enabled").default(1),
  learningMode: text("learning_mode").default("review"),
  learningCapturePreferences: integer("learning_capture_preferences").default(1),
  learningCapturePlaybooks: integer("learning_capture_playbooks").default(1),
  learningAutoPromoteThreshold: integer("learning_auto_promote_threshold").default(2),
  learningShowFeedback: integer("learning_show_feedback").default(1),
  backupEnabled: integer("backup_enabled").default(0),
  backupCron: text("backup_cron").default("0 */6 * * *"),
  backupRetentionCount: integer("backup_retention_count").default(14),
  backupIncludeLogs: integer("backup_include_logs").default(0),
  backupReplicationMode: text("backup_replication_mode").default("off"),
  backupReplicationTarget: text("backup_replication_target"),
  backupReplicationRsyncArgs: text("backup_replication_rsync_args"),
  backupLastRunAt: text("backup_last_run_at"),
  backupLastSuccessAt: text("backup_last_success_at"),
  backupLastError: text("backup_last_error"),
  backupLastBackupId: text("backup_last_backup_id"),
  provenanceMode: text("provenance_mode").default("meta"),
  acpAuthMode: text("acp_auth_mode").default("off"),
  acpAuthSecretName: text("acp_auth_secret_name"),
  asyncDelegationMaxConcurrent: integer("async_delegation_max_concurrent").default(3),
  laneMainMaxConcurrent: integer("lane_main_max_concurrent").default(4),
  laneCronMaxConcurrent: integer("lane_cron_max_concurrent").default(1),
  laneSubflowMaxConcurrent: integer("lane_subflow_max_concurrent").default(8),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryConfig = sqliteTable("memory_config", {
  id: text("id").primaryKey(), // always "default"
  tier: text("tier").notNull(), // "simple" | "thorough" | "auto"
  autoThreshold: integer("auto_threshold").default(50),
  totalMemories: integer("total_memories").default(0),
  storageBytes: integer("storage_bytes").default(0),
  embeddingModel: text("embedding_model").default("local"),
  searchBackend: text("search_backend").default("qmd-like"),
  rerankStrategy: text("rerank_strategy").default("auto"),
  queryExpansionEnabled: integer("query_expansion_enabled").default(1),
  strongSignalEnabled: integer("strong_signal_enabled").default(1),
  rerankCandidateLimit: integer("rerank_candidate_limit").default(40),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  agentId: text("agent_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata"), // JSON
  provenance: text("provenance"), // JSON
  createdAt: text("created_at").notNull(),
});

export const acpSessions = sqliteTable("acp_sessions", {
  sessionId: text("session_id").primaryKey(),
  sessionLabel: text("session_label"),
  status: text("status").notNull(),
  actor: text("actor"),
  client: text("client"),
  provenanceMode: text("provenance_mode"),
  lastTraceId: text("last_trace_id"),
  turnCount: integer("turn_count").default(0),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
});

export const appSecrets = sqliteTable("app_secrets", {
  name: text("name").primaryKey(),
  valueEnc: text("value_enc").notNull(),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  sourceUrl: text("source_url"),
  filePath: text("file_path"),
  sizeBytes: integer("size_bytes"),
  extractedText: text("extracted_text").notNull(),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const learningEvents = sqliteTable("learning_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  fingerprint: text("fingerprint").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const learningCandidates = sqliteTable("learning_candidates", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull(),
  kind: text("kind").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  content: text("content"),
  confidence: integer("confidence"),
  evidenceCount: integer("evidence_count").default(1),
  sourceEventIds: text("source_event_ids").notNull(),
  targetPath: text("target_path"),
  promotedAt: text("promoted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const standingGoalRuns = sqliteTable("standing_goal_runs", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull(),
  taskId: text("task_id"),
  sessionId: text("session_id").notNull(),
  status: text("status").notNull(),
  turnIndex: integer("turn_index").default(0),
  maxTurns: integer("max_turns").default(20),
  workerId: text("worker_id"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  lastJudgedAt: text("last_judged_at"),
  lastVerdict: text("last_verdict"),
  lastReason: text("last_reason"),
  consecutiveParseFailures: integer("consecutive_parse_failures").default(0),
  consecutiveSameBlockers: integer("consecutive_same_blockers").default(0),
  toolsUsedJson: text("tools_used_json").default("[]"),
  deliverablesJson: text("deliverables_json").default("[]"),
  evidenceSummary: text("evidence_summary"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const standingGoalJudgments = sqliteTable("standing_goal_judgments", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  goalId: text("goal_id").notNull(),
  taskId: text("task_id"),
  verdict: text("verdict").notNull(),
  reason: text("reason").notNull(),
  missingCriteriaJson: text("missing_criteria_json").default("[]"),
  satisfiedCriteriaJson: text("satisfied_criteria_json").default("[]"),
  rawResponse: text("raw_response"),
  createdAt: text("created_at").notNull(),
});

export const skillUsageEvents = sqliteTable("skill_usage_events", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull(),
  skillName: text("skill_name").notNull(),
  skillSource: text("skill_source").notNull(),
  eventKind: text("event_kind").notNull(),
  sessionId: text("session_id"),
  agentId: text("agent_id"),
  triggerText: text("trigger_text"),
  outcome: text("outcome"),
  evidenceJson: text("evidence_json").default("[]"),
  metadataJson: text("metadata_json").default("{}"),
  createdAt: text("created_at").notNull(),
});

export const skillCompoundingEvaluations = sqliteTable("skill_compounding_evaluations", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull(),
  skillName: text("skill_name").notNull(),
  status: text("status").notNull(),
  usageCount: integer("usage_count").default(0),
  successCount: integer("success_count").default(0),
  staleScore: integer("stale_score").default(0),
  recommendation: text("recommendation").notNull(),
  rationale: text("rationale").notNull(),
  evidenceJson: text("evidence_json").default("[]"),
  createdAt: text("created_at").notNull(),
});

export const channelSessionStartupSnapshots = sqliteTable("channel_session_startup_snapshots", {
  sessionId: text("session_id").notNull(),
  agentId: text("agent_id").notNull(),
  workspacePath: text("workspace_path").notNull(),
  startupContext: text("startup_context").notNull(),
  sourceFilesJson: text("source_files_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const backgroundJobs = sqliteTable("background_jobs", {
  id: text("id").primaryKey(),
  toolName: text("tool_name").notNull(),
  commandPreview: text("command_preview").notNull(),
  cwd: text("cwd"),
  sessionId: text("session_id"),
  agentId: text("agent_id"),
  notifyOnComplete: integer("notify_on_complete").notNull().default(0),
  status: text("status").notNull(),
  pid: integer("pid"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  exitCode: integer("exit_code"),
  stdout: text("stdout"),
  stderr: text("stderr"),
  metadata: text("metadata"),
});

export const memoryPromotionEvents = sqliteTable("memory_promotion_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  entryId: text("entry_id"),
  eventKind: text("event_kind").notNull(),
  source: text("source").notNull(),
  content: text("content").notNull(),
  backfillRunId: text("backfill_run_id"),
  detailJson: text("detail_json"),
  createdAt: text("created_at").notNull(),
});

export const workflowNodePinData = sqliteTable("workflow_node_pin_data", {
  workflowId: text("workflow_id").notNull(),
  nodeId: text("node_id").notNull(),
  dataJson: text("data_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowAgentTools = sqliteTable("workflow_agent_tools", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  toolName: text("tool_name").notNull().unique(),
  description: text("description").notNull(),
  inputSchemaJson: text("input_schema_json").notNull(),
  outputSchemaJson: text("output_schema_json"),
  allowedAgentIdsJson: text("allowed_agent_ids_json"),
  allowedOrganizationIdsJson: text("allowed_organization_ids_json"),
  approvalPolicy: text("approval_policy").notNull().default("inherit"),
  enabled: integer("enabled").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowCredentials = sqliteTable("workflow_credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  serviceType: text("service_type").notNull(),
  secretRef: text("secret_ref").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowVersions = sqliteTable("workflow_versions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  nodesJson: text("nodes_json").notNull(),
  edgesJson: text("edges_json").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull(),
});
