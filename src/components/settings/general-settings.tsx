"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { RefreshCw, Save } from "lucide-react";
import { CompletionNotificationsToggle } from "@/components/settings/completion-notifications-toggle";

interface AppConfig {
  timezone: string;
  learning_enabled: number;
  learning_mode: "off" | "review" | "auto";
  learning_capture_preferences: number;
  learning_capture_playbooks: number;
  learning_auto_promote_threshold: number;
  learning_show_feedback: number;
  backup_enabled: number;
  backup_cron: string;
  backup_retention_count: number;
  backup_include_logs: number;
  backup_replication_mode: "off" | "mirror-copy" | "rsync";
  backup_replication_target: string | null;
  backup_replication_rsync_args: string | null;
  backup_last_run_at?: string | null;
  backup_last_success_at?: string | null;
  backup_last_error?: string | null;
  backup_last_backup_id?: string | null;
  learning_llm_review_enabled: number;
  learning_llm_review_interval: number;
  tool_output_limit: number;
  compaction_mode: "off" | "summarize" | "drop";
  compaction_threshold: number;
  context_window: number;
  memory_flush_soft_threshold_tokens: number;
  compaction_keep_recent_tokens: number;
  compaction_reserve_tokens_floor: number;
  compaction_model_ref: string | null;
  compaction_identifier_policy: "strict" | "off" | "custom";
  compaction_identifier_instructions: string | null;
  compaction_quality_guard_enabled: number;
  compaction_quality_guard_max_retries: number;
  context_pruning_mode: "off" | "tool-results";
  context_pruning_keep_recent_assistants: number;
  context_pruning_min_tool_chars: number;
  context_pruning_max_tool_chars: number;
  context_pruning_head_chars: number;
  context_pruning_tail_chars: number;
  channel_retry_attempts: number;
  channel_retry_min_delay_ms: number;
  channel_retry_max_delay_ms: number;
  channel_retry_jitter: number;
  provenance_mode: "off" | "meta" | "meta+receipt";
  telemetry_enabled: number;
  hooks_enabled: number;
  memory_flush_enabled: number;
  rate_limit_webhooks: number;
  rate_limit_execute: number;
  rate_limit_channels: number;
  lane_main_max_concurrent: number;
  lane_cron_max_concurrent: number;
  lane_subflow_max_concurrent: number;
  log_max_days: number;
  decay_enabled: number;
  decay_half_life_days: number;
  web_search_provider: "duckduckgo" | "tavily" | "exa" | "brave";
  web_search_api_key: string | null;
  browser_backend: "playwright" | "auto" | "cdp-existing";
  browser_cdp_url: string | null;
  checkpoint_enabled: number;
  image_generation_api_key: string | null;
  image_generation_provider: string | null;
  mcp_servers: string;
}

const DEFAULTS: AppConfig = {
  timezone: "UTC",
  learning_enabled: 1,
  learning_mode: "review",
  learning_capture_preferences: 1,
  learning_capture_playbooks: 1,
  learning_auto_promote_threshold: 2,
  learning_show_feedback: 1,
  backup_enabled: 0,
  backup_cron: "0 */6 * * *",
  backup_retention_count: 14,
  backup_include_logs: 0,
  backup_replication_mode: "off",
  backup_replication_target: null,
  backup_replication_rsync_args: null,
  learning_llm_review_enabled: 1,
  learning_llm_review_interval: 10,
  tool_output_limit: 8000,
  compaction_mode: "off",
  compaction_threshold: 0.75,
  context_window: 200000,
  memory_flush_soft_threshold_tokens: 4000,
  compaction_keep_recent_tokens: 20000,
  compaction_reserve_tokens_floor: 20000,
  compaction_model_ref: null,
  compaction_identifier_policy: "strict",
  compaction_identifier_instructions: null,
  compaction_quality_guard_enabled: 0,
  compaction_quality_guard_max_retries: 1,
  context_pruning_mode: "tool-results",
  context_pruning_keep_recent_assistants: 3,
  context_pruning_min_tool_chars: 12000,
  context_pruning_max_tool_chars: 4000,
  context_pruning_head_chars: 1500,
  context_pruning_tail_chars: 1500,
  channel_retry_attempts: 3,
  channel_retry_min_delay_ms: 400,
  channel_retry_max_delay_ms: 30000,
  channel_retry_jitter: 0.1,
  provenance_mode: "meta",
  telemetry_enabled: 1,
  hooks_enabled: 1,
  memory_flush_enabled: 1,
  rate_limit_webhooks: 30,
  rate_limit_execute: 20,
  rate_limit_channels: 60,
  lane_main_max_concurrent: 4,
  lane_cron_max_concurrent: 1,
  lane_subflow_max_concurrent: 8,
  log_max_days: 7,
  decay_enabled: 1,
  decay_half_life_days: 30,
  web_search_provider: "duckduckgo",
  web_search_api_key: null,
  browser_backend: "playwright",
  browser_cdp_url: null,
  checkpoint_enabled: 1,
  image_generation_api_key: null,
  image_generation_provider: null,
  mcp_servers: '[]',
};

export function GeneralSettings() {
  const [config, setConfig] = useState<AppConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [imageCaps, setImageCaps] = useState<{ configured: boolean; activeProvider: string | null; activeSupportsEditing: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/image-gen/capabilities")
      .then((r) => r.json())
      .then((j) => { if (j.success) setImageCaps(j.data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j: { success: boolean; data?: Partial<AppConfig> }) => {
        if (j.success && j.data) {
          setConfig({
            timezone: j.data.timezone ?? DEFAULTS.timezone,
            learning_enabled: j.data.learning_enabled ?? DEFAULTS.learning_enabled,
            learning_mode: j.data.learning_mode ?? DEFAULTS.learning_mode,
            learning_capture_preferences:
              j.data.learning_capture_preferences ?? DEFAULTS.learning_capture_preferences,
            learning_capture_playbooks:
              j.data.learning_capture_playbooks ?? DEFAULTS.learning_capture_playbooks,
            learning_auto_promote_threshold:
              j.data.learning_auto_promote_threshold ?? DEFAULTS.learning_auto_promote_threshold,
            learning_show_feedback:
              j.data.learning_show_feedback ?? DEFAULTS.learning_show_feedback,
            backup_enabled: j.data.backup_enabled ?? DEFAULTS.backup_enabled,
            backup_cron: j.data.backup_cron ?? DEFAULTS.backup_cron,
            backup_retention_count: j.data.backup_retention_count ?? DEFAULTS.backup_retention_count,
            backup_include_logs: j.data.backup_include_logs ?? DEFAULTS.backup_include_logs,
            backup_replication_mode: j.data.backup_replication_mode ?? DEFAULTS.backup_replication_mode,
            backup_replication_target: j.data.backup_replication_target ?? DEFAULTS.backup_replication_target,
            backup_replication_rsync_args: j.data.backup_replication_rsync_args ?? DEFAULTS.backup_replication_rsync_args,
            backup_last_run_at: j.data.backup_last_run_at ?? null,
            backup_last_success_at: j.data.backup_last_success_at ?? null,
            backup_last_error: j.data.backup_last_error ?? null,
            backup_last_backup_id: j.data.backup_last_backup_id ?? null,
            learning_llm_review_enabled:
              j.data.learning_llm_review_enabled ?? DEFAULTS.learning_llm_review_enabled,
            learning_llm_review_interval:
              j.data.learning_llm_review_interval ?? DEFAULTS.learning_llm_review_interval,
            tool_output_limit: j.data.tool_output_limit ?? DEFAULTS.tool_output_limit,
            compaction_mode: j.data.compaction_mode ?? DEFAULTS.compaction_mode,
            compaction_threshold: j.data.compaction_threshold ?? DEFAULTS.compaction_threshold,
            context_window: j.data.context_window ?? DEFAULTS.context_window,
            memory_flush_soft_threshold_tokens:
              j.data.memory_flush_soft_threshold_tokens ?? DEFAULTS.memory_flush_soft_threshold_tokens,
            compaction_keep_recent_tokens:
              j.data.compaction_keep_recent_tokens ?? DEFAULTS.compaction_keep_recent_tokens,
            compaction_reserve_tokens_floor:
              j.data.compaction_reserve_tokens_floor ?? DEFAULTS.compaction_reserve_tokens_floor,
            compaction_model_ref: j.data.compaction_model_ref ?? DEFAULTS.compaction_model_ref,
            compaction_identifier_policy:
              j.data.compaction_identifier_policy ?? DEFAULTS.compaction_identifier_policy,
            compaction_identifier_instructions:
              j.data.compaction_identifier_instructions ?? DEFAULTS.compaction_identifier_instructions,
            compaction_quality_guard_enabled:
              j.data.compaction_quality_guard_enabled ?? DEFAULTS.compaction_quality_guard_enabled,
            compaction_quality_guard_max_retries:
              j.data.compaction_quality_guard_max_retries ?? DEFAULTS.compaction_quality_guard_max_retries,
            context_pruning_mode: j.data.context_pruning_mode ?? DEFAULTS.context_pruning_mode,
            context_pruning_keep_recent_assistants:
              j.data.context_pruning_keep_recent_assistants ?? DEFAULTS.context_pruning_keep_recent_assistants,
            context_pruning_min_tool_chars:
              j.data.context_pruning_min_tool_chars ?? DEFAULTS.context_pruning_min_tool_chars,
            context_pruning_max_tool_chars:
              j.data.context_pruning_max_tool_chars ?? DEFAULTS.context_pruning_max_tool_chars,
            context_pruning_head_chars:
              j.data.context_pruning_head_chars ?? DEFAULTS.context_pruning_head_chars,
            context_pruning_tail_chars:
              j.data.context_pruning_tail_chars ?? DEFAULTS.context_pruning_tail_chars,
            channel_retry_attempts: j.data.channel_retry_attempts ?? DEFAULTS.channel_retry_attempts,
            channel_retry_min_delay_ms: j.data.channel_retry_min_delay_ms ?? DEFAULTS.channel_retry_min_delay_ms,
            channel_retry_max_delay_ms: j.data.channel_retry_max_delay_ms ?? DEFAULTS.channel_retry_max_delay_ms,
            channel_retry_jitter: j.data.channel_retry_jitter ?? DEFAULTS.channel_retry_jitter,
            provenance_mode: j.data.provenance_mode ?? DEFAULTS.provenance_mode,
            telemetry_enabled: j.data.telemetry_enabled ?? DEFAULTS.telemetry_enabled,
            hooks_enabled: j.data.hooks_enabled ?? DEFAULTS.hooks_enabled,
            memory_flush_enabled: j.data.memory_flush_enabled ?? DEFAULTS.memory_flush_enabled,
            rate_limit_webhooks: j.data.rate_limit_webhooks ?? DEFAULTS.rate_limit_webhooks,
            rate_limit_execute: j.data.rate_limit_execute ?? DEFAULTS.rate_limit_execute,
            rate_limit_channels: j.data.rate_limit_channels ?? DEFAULTS.rate_limit_channels,
            lane_main_max_concurrent: j.data.lane_main_max_concurrent ?? DEFAULTS.lane_main_max_concurrent,
            lane_cron_max_concurrent: j.data.lane_cron_max_concurrent ?? DEFAULTS.lane_cron_max_concurrent,
            lane_subflow_max_concurrent: j.data.lane_subflow_max_concurrent ?? DEFAULTS.lane_subflow_max_concurrent,
            log_max_days: j.data.log_max_days ?? DEFAULTS.log_max_days,
            decay_enabled: j.data.decay_enabled ?? DEFAULTS.decay_enabled,
            decay_half_life_days: j.data.decay_half_life_days ?? DEFAULTS.decay_half_life_days,
            web_search_provider: j.data.web_search_provider ?? DEFAULTS.web_search_provider,
            web_search_api_key: j.data.web_search_api_key ?? DEFAULTS.web_search_api_key,
            browser_backend: j.data.browser_backend ?? DEFAULTS.browser_backend,
            browser_cdp_url: j.data.browser_cdp_url ?? DEFAULTS.browser_cdp_url,
            checkpoint_enabled: j.data.checkpoint_enabled ?? DEFAULTS.checkpoint_enabled,
            image_generation_api_key: j.data.image_generation_api_key ?? DEFAULTS.image_generation_api_key,
            image_generation_provider: j.data.image_generation_provider ?? DEFAULTS.image_generation_provider,
            mcp_servers: j.data.mcp_servers ?? DEFAULTS.mcp_servers,
          });
        }
      })
      .catch((err) => console.error("Failed to load config", String(err)));
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const j = await res.json() as { success: boolean; error?: string };
      setStatus(j.success ? "Saved." : `Error: ${j.error}`);
    } catch (err) {
      setStatus(`Error: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const rerunOnboarding = () => {
    window.location.href = "/onboarding";
  };

  const showCompactionFields = config.compaction_mode !== "off";

  return (
    <Card>
      <CardHeader><CardTitle>General Settings</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>Timezone</Label>
          <Input
            value={config.timezone}
            onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
            className="mt-1"
          />
        </div>

        <CompletionNotificationsToggle />

        <Separator />

        <div className="space-y-3">
          <div>
            <Label>Self-Learning</Label>
            <div className="mt-2 flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">System learns with evidence</div>
                <p className="text-xs text-muted-foreground">
                  Capture repeated successful patterns and explicit preferences, then keep them in review mode or auto-promote them.
                </p>
              </div>
              <Switch
                checked={config.learning_enabled === 1}
                onCheckedChange={(checked) => setConfig({ ...config, learning_enabled: checked ? 1 : 0 })}
              />
            </div>
          </div>

          <div>
            <Label>Learning Mode</Label>
            <Select
              value={config.learning_mode}
              onValueChange={(v) => setConfig({ ...config, learning_mode: v as AppConfig["learning_mode"] })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="review">Review Candidates</SelectItem>
                <SelectItem value="auto">Auto Promote</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border px-3 py-2">
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-sm">Capture User Preferences</Label>
                <Switch
                  checked={config.learning_capture_preferences === 1}
                  onCheckedChange={(checked) => setConfig({ ...config, learning_capture_preferences: checked ? 1 : 0 })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Learn things like provider preferences, setup style, and repeated “always use / don’t use” instructions.
              </p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-sm">Capture Playbooks</Label>
                <Switch
                  checked={config.learning_capture_playbooks === 1}
                  onCheckedChange={(checked) => setConfig({ ...config, learning_capture_playbooks: checked ? 1 : 0 })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Distill repeated successful workflow, org, scheduler, and agent-control patterns into reviewable learned skills.
              </p>
            </div>
          </div>

          <div>
            <Label>Auto-Promote Threshold</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={config.learning_auto_promote_threshold}
              onChange={(e) => setConfig({ ...config, learning_auto_promote_threshold: Number(e.target.value) || 1 })}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              How many successful evidence events a playbook candidate needs before auto-promotion in Auto mode.
            </p>
          </div>

          <div className="rounded-md border px-3 py-2">
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-sm">Show Learning Feedback</Label>
              <Switch
                checked={config.learning_show_feedback === 1}
                onCheckedChange={(checked) => setConfig({ ...config, learning_show_feedback: checked ? 1 : 0 })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Show lightweight post-reply feedback when disp8ch updates profile, workspace context, preferences, or playbooks from a turn.
            </p>
          </div>

          <div className="rounded-md border px-3 py-2">
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-sm">LLM Review (Implicit Signals)</Label>
              <Switch
                checked={config.learning_llm_review_enabled === 1}
                onCheckedChange={(checked) =>
                  setConfig({ ...config, learning_llm_review_enabled: checked ? 1 : 0 })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Every N turns, run a background LLM review to catch implicit preferences and behavioral patterns that regex misses.
              Uses the cheapest model from your configured providers — no separate API key needed.
            </p>
            {config.learning_llm_review_enabled === 1 && (
              <div className="mt-2">
                <Label className="text-xs">Review Interval (turns)</Label>
                <Input
                  type="number"
                  min={3}
                  max={50}
                  value={config.learning_llm_review_interval}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      learning_llm_review_interval: Math.max(3, Math.min(50, Number(e.target.value) || 10)),
                    })
                  }
                  className="mt-1 w-24"
                />
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <Label>Automated Backups</Label>
            <div className="mt-2 flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Run verified backup policy automatically</div>
                <p className="text-xs text-muted-foreground">
                  Creates a verified snapshot on a cron schedule, prunes old snapshots, and can mirror copies to another path or rsync target.
                </p>
              </div>
              <Switch
                checked={config.backup_enabled === 1}
                onCheckedChange={(checked) => setConfig({ ...config, backup_enabled: checked ? 1 : 0 })}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Backup Cron</Label>
              <Input
                value={config.backup_cron}
                onChange={(e) => setConfig({ ...config, backup_cron: e.target.value })}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Default `0 */6 * * *` runs every 6 hours.
              </p>
            </div>
            <div>
              <Label>Retention Count</Label>
              <Input
                type="number"
                min={1}
                max={200}
                value={config.backup_retention_count}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    backup_retention_count: Math.max(1, Math.min(200, Number(e.target.value) || 14)),
                  })
                }
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Keeps the newest N snapshots and prunes older ones after a successful policy run.
              </p>
            </div>
          </div>

          <div className="rounded-md border px-3 py-2">
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-sm">Include Logs In Snapshots</Label>
              <Switch
                checked={config.backup_include_logs === 1}
                onCheckedChange={(checked) => setConfig({ ...config, backup_include_logs: checked ? 1 : 0 })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Store `data/logs` inside scheduled snapshots. Leave this off if logs are noisy and you only need app state.
            </p>
          </div>

          <div>
            <Label>Replication Mode</Label>
            <Select
              value={config.backup_replication_mode}
              onValueChange={(v) => setConfig({ ...config, backup_replication_mode: v as AppConfig["backup_replication_mode"] })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="mirror-copy">Mirror Copy Path</SelectItem>
                <SelectItem value="rsync">rsync</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {config.backup_replication_mode !== "off" && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>Replication Target</Label>
                <Input
                  value={config.backup_replication_target ?? ""}
                  onChange={(e) => setConfig({ ...config, backup_replication_target: e.target.value || null })}
                  className="mt-1"
                  placeholder={config.backup_replication_mode === "rsync" ? "user@host:/srv/disp8ch-backups" : "/mnt/backup-drive/disp8ch"}
                />
              </div>
              {config.backup_replication_mode === "rsync" && (
                <div>
                  <Label>rsync Args</Label>
                  <Input
                    value={config.backup_replication_rsync_args ?? ""}
                    onChange={(e) => setConfig({ ...config, backup_replication_rsync_args: e.target.value || null })}
                    className="mt-1"
                    placeholder="--compress --partial"
                  />
                </div>
              )}
            </div>
          )}

          <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
            <div>Last run: {config.backup_last_run_at || "never"}</div>
            <div>Last success: {config.backup_last_success_at || "never"}</div>
            <div>Last backup id: {config.backup_last_backup_id || "none"}</div>
            <div>Last error: {config.backup_last_error || "none"}</div>
          </div>
        </div>

        <Separator />

        <div>
          <Label>Tool Output Limit (chars)</Label>
          <Input
            type="number"
            value={config.tool_output_limit}
            min={1000}
            max={500000}
            step={1000}
            onChange={(e) => setConfig({ ...config, tool_output_limit: Number(e.target.value) })}
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Max characters returned per tool call. Default: 8000. Raise for larger file/HTTP responses.
          </p>
        </div>

        <div>
          <Label>Context Compaction</Label>
          <Select
            value={config.compaction_mode}
            onValueChange={(v) => setConfig({ ...config, compaction_mode: v as AppConfig["compaction_mode"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Truncate only (default)</SelectItem>
              <SelectItem value="summarize">LLM Summarization</SelectItem>
              <SelectItem value="drop">Drop Oldest</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            What to do when the messages array approaches the context window limit.
          </p>
        </div>

        <div>
          <Label>Context Pruning</Label>
          <Select
            value={config.context_pruning_mode}
            onValueChange={(v) => setConfig({ ...config, context_pruning_mode: v as AppConfig["context_pruning_mode"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="tool-results">Trim old tool results</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Temporarily trims bulky old tool outputs before model calls. This keeps recent conversation intact and does not rewrite stored history.
          </p>
        </div>

        {config.context_pruning_mode !== "off" && (
          <>
            <div>
              <Label>Protected Recent Assistant Turns</Label>
              <Input
                type="number"
                value={config.context_pruning_keep_recent_assistants}
                min={1}
                max={12}
                step={1}
                onChange={(e) => setConfig({ ...config, context_pruning_keep_recent_assistants: Number(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label>Minimum Tool Result Size To Trim (chars)</Label>
              <Input
                type="number"
                value={config.context_pruning_min_tool_chars}
                min={1000}
                max={200000}
                step={1000}
                onChange={(e) => setConfig({ ...config, context_pruning_min_tool_chars: Number(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label>Trimmed Tool Result Size Cap (chars)</Label>
              <Input
                type="number"
                value={config.context_pruning_max_tool_chars}
                min={500}
                max={20000}
                step={250}
                onChange={(e) => setConfig({ ...config, context_pruning_max_tool_chars: Number(e.target.value) })}
                className="mt-1"
              />
            </div>
          </>
        )}

        {showCompactionFields && (
          <>
            <div>
              <Label>Compact At (% of context window)</Label>
              <Input
                type="number"
                value={Math.round(config.compaction_threshold * 100)}
                min={10}
                max={95}
                step={5}
                onChange={(e) => setConfig({ ...config, compaction_threshold: Number(e.target.value) / 100 })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Trigger compaction when estimated token usage exceeds this % of the context window.
              </p>
            </div>

            <div>
              <Label>Context Window (tokens)</Label>
              <Input
                type="number"
                value={config.context_window}
                min={1000}
                step={10000}
                onChange={(e) => setConfig({ ...config, context_window: Number(e.target.value) })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                LLM context window size in tokens. Used to calculate when to compact.
              </p>
            </div>

            <div>
              <Label>Keep Recent Context Budget (tokens)</Label>
              <Input
                type="number"
                value={config.compaction_keep_recent_tokens}
                min={2000}
                step={1000}
                onChange={(e) => setConfig({ ...config, compaction_keep_recent_tokens: Number(e.target.value) })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Target token budget to preserve verbatim before older turns are compacted into a handoff summary.
              </p>
            </div>

            <div>
              <Label>Reserve Tokens Floor</Label>
              <Input
                type="number"
                value={config.compaction_reserve_tokens_floor}
                min={1000}
                step={1000}
                onChange={(e) => setConfig({ ...config, compaction_reserve_tokens_floor: Number(e.target.value) })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Minimum headroom disp8ch keeps free for the current reply before compaction triggers.
              </p>
            </div>

            <div>
              <Label>Compaction Model Override</Label>
              <Input
                value={config.compaction_model_ref ?? ""}
                onChange={(e) => setConfig({ ...config, compaction_model_ref: e.target.value.trim() || null })}
                className="mt-1"
                placeholder="model row id or provider:model-id"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Optional cheaper or stronger model used only for compaction summaries.
              </p>
            </div>

            <div>
              <Label>Identifier Retention</Label>
              <Select
                value={config.compaction_identifier_policy}
                onValueChange={(v) => setConfig({ ...config, compaction_identifier_policy: v as AppConfig["compaction_identifier_policy"] })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="strict">Strict</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.compaction_identifier_policy === "custom" && (
              <div>
                <Label>Identifier Retention Instructions</Label>
                <Input
                  value={config.compaction_identifier_instructions ?? ""}
                  onChange={(e) => setConfig({ ...config, compaction_identifier_instructions: e.target.value.trim() || null })}
                  className="mt-1"
                  placeholder="Preserve ports, file paths, hashes, and ticket IDs."
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <Label>Summary Quality Guard</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Re-audit summaries for missing identifiers, headings, and the latest user ask before accepting them.
                </p>
              </div>
              <Switch
                checked={config.compaction_quality_guard_enabled === 1}
                onCheckedChange={(checked) => setConfig({ ...config, compaction_quality_guard_enabled: checked ? 1 : 0 })}
              />
            </div>

            {config.compaction_quality_guard_enabled === 1 && (
              <div>
                <Label>Quality Guard Retries</Label>
                <Input
                  type="number"
                  value={config.compaction_quality_guard_max_retries}
                  min={0}
                  max={5}
                  step={1}
                  onChange={(e) => setConfig({ ...config, compaction_quality_guard_max_retries: Number(e.target.value) })}
                  className="mt-1"
                />
              </div>
            )}
          </>
        )}

        <Separator />

        <div className="flex gap-2 items-center">
          <Button onClick={save} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save Settings"}
          </Button>
          {status && (
            <span className={`text-sm ${status.startsWith("Error") ? "text-destructive" : "text-muted-foreground"}`}>
              {status}
            </span>
          )}
        </div>

        <Separator />

        <div>
          <Label>Ingress Provenance Mode</Label>
          <Select
            value={config.provenance_mode}
            onValueChange={(v) => setConfig({ ...config, provenance_mode: v as AppConfig["provenance_mode"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="meta">Meta only</SelectItem>
              <SelectItem value="meta+receipt">Meta + receipt</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Ingress provenance policy. `meta` injects session trace context into runs; `meta+receipt` also adds a visible receipt block into the agent prompt context.
          </p>
        </div>

        <div>
          <Label>Channel Retry Attempts</Label>
          <Input
            type="number"
            value={config.channel_retry_attempts}
            min={1}
            max={10}
            step={1}
            onChange={(e) => setConfig({ ...config, channel_retry_attempts: Number(e.target.value) })}
            className="mt-1"
          />
        </div>

        <div>
          <Label>Channel Retry Min Delay (ms)</Label>
          <Input
            type="number"
            value={config.channel_retry_min_delay_ms}
            min={10}
            max={10000}
            step={10}
            onChange={(e) => setConfig({ ...config, channel_retry_min_delay_ms: Number(e.target.value) })}
            className="mt-1"
          />
        </div>

        <div>
          <Label>Channel Retry Max Delay (ms)</Label>
          <Input
            type="number"
            value={config.channel_retry_max_delay_ms}
            min={100}
            max={120000}
            step={100}
            onChange={(e) => setConfig({ ...config, channel_retry_max_delay_ms: Number(e.target.value) })}
            className="mt-1"
          />
        </div>

        <div>
          <Label>Channel Retry Jitter (0 to 0.5)</Label>
          <Input
            type="number"
            value={config.channel_retry_jitter}
            min={0}
            max={0.5}
            step={0.05}
            onChange={(e) => setConfig({ ...config, channel_retry_jitter: Number(e.target.value) })}
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Adds randomized delay spread to avoid synchronized retry bursts.
          </p>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div>
            <Label>Telemetry Logging</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Write runtime events to <code>data/telemetry/events.jsonl</code>.
            </p>
          </div>
          <Switch
            checked={config.telemetry_enabled === 1}
            onCheckedChange={(checked) => setConfig({ ...config, telemetry_enabled: checked ? 1 : 0 })}
          />
        </div>

        {config.memory_flush_enabled === 1 && (
          <div>
            <Label>Memory Flush Soft Threshold (tokens)</Label>
            <Input
              type="number"
              value={config.memory_flush_soft_threshold_tokens}
              min={0}
              step={500}
              onChange={(e) => setConfig({ ...config, memory_flush_soft_threshold_tokens: Number(e.target.value) })}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Start one durable-memory extraction pass this many tokens before full compaction would trigger.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <Label>Hooks Runtime</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Execute hook scripts from <code>data/workspace/hooks</code>.
            </p>
          </div>
          <Switch
            checked={config.hooks_enabled === 1}
            onCheckedChange={(checked) => setConfig({ ...config, hooks_enabled: checked ? 1 : 0 })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Pre-Compaction Memory Flush</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Extract durable facts from conversation before context compaction runs.
            </p>
          </div>
          <Switch
            checked={config.memory_flush_enabled === 1}
            onCheckedChange={(checked) => setConfig({ ...config, memory_flush_enabled: checked ? 1 : 0 })}
          />
        </div>

        <Separator />

        <div>
          <Label className="text-base font-medium">Memory Decay</Label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Temporal Decay</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Older memories score lower in search. MEMORY.md entries are always evergreen.
            </p>
          </div>
          <Switch
            checked={config.decay_enabled === 1}
            onCheckedChange={(checked) => setConfig({ ...config, decay_enabled: checked ? 1 : 0 })}
          />
        </div>

        {config.decay_enabled === 1 && (
          <div>
            <Label>Decay Half-Life (days)</Label>
            <Input
              type="number"
              value={config.decay_half_life_days}
              min={1}
              max={365}
              step={1}
              onChange={(e) => setConfig({ ...config, decay_half_life_days: Number(e.target.value) })}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              A memory at this age scores 50% of its original relevance. Default: 30 days.
            </p>
          </div>
        )}

        <Separator />

        <div>
          <Label className="text-base font-medium">API Rate Limits (requests/min per IP)</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Limits refresh every 60 seconds. Changes take effect within one minute.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Webhooks</Label>
            <Input
              type="number"
              value={config.rate_limit_webhooks}
              min={1}
              max={1000}
              step={5}
              onChange={(e) => setConfig({ ...config, rate_limit_webhooks: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Execute</Label>
            <Input
              type="number"
              value={config.rate_limit_execute}
              min={1}
              max={1000}
              step={5}
              onChange={(e) => setConfig({ ...config, rate_limit_execute: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Chat (channels)</Label>
            <Input
              type="number"
              value={config.rate_limit_channels}
              min={1}
              max={1000}
              step={5}
              onChange={(e) => setConfig({ ...config, rate_limit_channels: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
        </div>

        <Separator />

        <div>
          <Label className="text-base font-medium">Execution Lane Concurrency</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Controls how many workflows run at once in each lane.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Main Lane</Label>
            <Input
              type="number"
              value={config.lane_main_max_concurrent}
              min={1}
              max={32}
              step={1}
              onChange={(e) => setConfig({ ...config, lane_main_max_concurrent: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Scheduler Lane</Label>
            <Input
              type="number"
              value={config.lane_cron_max_concurrent}
              min={1}
              max={16}
              step={1}
              onChange={(e) => setConfig({ ...config, lane_cron_max_concurrent: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Subflow Lane</Label>
            <Input
              type="number"
              value={config.lane_subflow_max_concurrent}
              min={1}
              max={64}
              step={1}
              onChange={(e) => setConfig({ ...config, lane_subflow_max_concurrent: Number(e.target.value) })}
              className="mt-1"
            />
          </div>
        </div>

        <Separator />

        <div>
          <Label>Log Retention (days)</Label>
          <Input
            type="number"
            value={config.log_max_days}
            min={1}
            max={365}
            step={1}
            onChange={(e) => setConfig({ ...config, log_max_days: Number(e.target.value) })}
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Daily log files older than this are pruned on next startup. Default: 7 days.
          </p>
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-3">Checkpoints / Rollback</h3>
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Local Checkpoints</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Creates an automatic snapshot of files before destructive tool commands (write_file, bash_exec) using a shadow git repo.
              </p>
            </div>
            <Switch
              checked={config.checkpoint_enabled === 1}
              onCheckedChange={(checked) => setConfig({ ...config, checkpoint_enabled: checked ? 1 : 0 })}
            />
          </div>
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-3">Image Generation</h3>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <Label>Provider</Label>
              <Select
                value={config.image_generation_provider || "auto"}
                onValueChange={(v) =>
                  setConfig({ ...config, image_generation_provider: v === "auto" ? null : v })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  <SelectItem value="fal">FAL.ai</SelectItem>
                  <SelectItem value="openai">OpenAI (DALL-E / GPT Image)</SelectItem>
                  <SelectItem value="xai">xAI (Grok)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Auto-detect tries FAL, OpenAI, and xAI in order.
              </p>
            </div>
          </div>
          <div>
            <Label>API Key</Label>
            <Input
              type="password"
              placeholder="key-... or secret:FAL_API_KEY"
              value={config.image_generation_api_key ?? ""}
              onChange={(e) => setConfig({ ...config, image_generation_api_key: e.target.value || null })}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              API key for the image generation provider. Use <code>secret:NAME</code> to reference an encrypted secret. Supports FAL.ai, OpenAI, and xAI keys.
            </p>
          </div>
        </div>
        {imageCaps && (
          <p className="text-xs mt-2">
            {!imageCaps.configured ? (
              <span className="text-muted-foreground">No image provider configured — image generation and editing are unavailable until a key is set.</span>
            ) : imageCaps.activeSupportsEditing ? (
              <span className="text-green-400">Active provider ({imageCaps.activeProvider}) supports image editing — attach an image in WebChat and ask for an edit.</span>
            ) : (
              <span className="text-amber-400">Active provider ({imageCaps.activeProvider}) supports generation only. Use an edit-capable provider (e.g. OpenAI) to edit images.</span>
            )}
          </p>
        )}

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-3">Web Search</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Provider</Label>
              <Select
                value={config.web_search_provider}
                onValueChange={(v) =>
                  setConfig({ ...config, web_search_provider: v as AppConfig["web_search_provider"] })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="duckduckgo">DuckDuckGo (free)</SelectItem>
                  <SelectItem value="tavily">Tavily</SelectItem>
                  <SelectItem value="exa">Exa</SelectItem>
                  <SelectItem value="brave">Brave Search</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                DuckDuckGo requires no API key. Others require a key below.
              </p>
            </div>
            <div>
              <Label>API Key</Label>
              <Input
                type="password"
                placeholder="sk-... or secret:MY_SEARCH_KEY"
                value={config.web_search_api_key ?? ""}
                onChange={(e) => setConfig({ ...config, web_search_api_key: e.target.value || null })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Use <code>secret:NAME</code> to reference an encrypted secret.
              </p>
            </div>
          </div>
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold mb-3">Browser — CDP Attach</h3>
          <Label>Browser Backend</Label>
          <Select
            value={config.browser_backend}
            onValueChange={(value: "playwright" | "auto" | "cdp-existing") =>
              setConfig({ ...config, browser_backend: value })
            }
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="playwright">Playwright</SelectItem>
              <SelectItem value="auto">Auto: CDP first, then Playwright fallback</SelectItem>
              <SelectItem value="cdp-existing">CDP existing browser only</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Keeps <code>browser_action</code> stable while choosing whether sessions launch locally with
            Playwright or attach to an existing CDP browser first.
          </p>
        </div>

        <div>
          <Label>Remote Debugging URL</Label>
          <Input
            type="text"
            placeholder="http://localhost:9222"
            value={config.browser_cdp_url ?? ""}
            onChange={(e) => setConfig({ ...config, browser_cdp_url: e.target.value || null })}
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Connect browser tools to an existing Chrome/Brave/Edge session. Start Chrome with{" "}
            <code>--remote-debugging-port=9222</code> then use the{" "}
            <code>browser_action connect_existing</code> tool.
          </p>
        </div>

        <Separator />

        <Button variant="outline" onClick={rerunOnboarding}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Re-run Setup Wizard
        </Button>
      </CardContent>
    </Card>
  );
}
