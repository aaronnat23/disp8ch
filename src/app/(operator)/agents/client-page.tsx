"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { useRouter, useSearchParams } from "next/navigation";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { PROVIDERS } from "@/types/model";
import type { AgentCreatePreset } from "@/components/agents/AgentSidebar";
import { AgentSidebar, AgentOverview, AgentFiles, AgentTools, AgentSkills, AgentChannels, AgentScheduler, AgentRoles } from "@/app/agents/dynamic-panels";
import {
  AgentRecord,
  AgentForm,
  AgentFile,
  AgentTool,
  AgentSkillPack,
  AgentExtensionPack,
  IntegrationPreset,
  AgentChannelStatus,
  AgentChannelWorkflow,
  AgentCronSummary,
  AgentCronJob,
  AgentRole,
  AgentRoleDraft,
  ModelOption,
  AgentTab,
  EMPTY_FORM,
  SKILL_FILE_GUIDE,
  AGENTS_UI_STATE_KEY,
  formatUsd,
} from "@/components/agents/types";

export default function AgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AgentTab>("overview");
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [savingOverview, setSavingOverview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [customModelProvider, setCustomModelProvider] = useState("");
  const [customModelId, setCustomModelId] = useState("");

  const [files, setFiles] = useState<AgentFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileBaseContent, setFileBaseContent] = useState("");
  const [fileDraftContent, setFileDraftContent] = useState("");
  const [savingFile, setSavingFile] = useState(false);

  const [tools, setTools] = useState<AgentTool[]>([]);
  const [skillPacks, setSkillPacks] = useState<AgentSkillPack[]>([]);
  const [extensionPacks, setExtensionPacks] = useState<AgentExtensionPack[]>([]);
  const [integrationPresets, setIntegrationPresets] = useState<IntegrationPreset[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [savingTools, setSavingTools] = useState(false);
  const [toolFilter, setToolFilter] = useState("");

  const [channels, setChannels] = useState<AgentChannelStatus[]>([]);
  const [channelWorkflows, setChannelWorkflows] = useState<AgentChannelWorkflow[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);

  const [cronSummary, setCronSummary] = useState<AgentCronSummary>({
    totalJobs: 0,
    scheduledJobs: 0,
    activeWorkflows: 0,
  });
  const [cronJobs, setCronJobs] = useState<AgentCronJob[]>([]);
  const [cronLoading, setCronLoading] = useState(false);

  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, AgentRoleDraft>>({});
  const [rolesLoading, setRolesLoading] = useState(false);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [deleteAgentOpen, setDeleteAgentOpen] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );
  const selectedAgentRole = useMemo(
    () => roles.find((role) => role.agentId === selectedAgentId) ?? null,
    [roles, selectedAgentId],
  );

  const activeModelOptions = useMemo(
    () =>
      models
        .filter((model) => model.isActive)
        .sort((a, b) => b.priority - a.priority),
    [models],
  );

  const hasConfiguredModelRef = useMemo(
    () => Boolean(form.modelRef && activeModelOptions.some((model) => model.id === form.modelRef)),
    [activeModelOptions, form.modelRef],
  );

  const modelMode = useMemo(() => {
    if (!form.modelRef) return "global";
    if (hasConfiguredModelRef) return "configured";
    return "custom";
  }, [form.modelRef, hasConfiguredModelRef]);

  const filteredTools = useMemo(() => {
    const filter = toolFilter.trim().toLowerCase();
    if (!filter) return tools;
    return tools.filter((tool) =>
      `${tool.name} ${tool.label} ${tool.description}`.toLowerCase().includes(filter),
    );
  }, [toolFilter, tools]);

  const skillFileEntries = useMemo(() => {
    const byName = new Map(files.map((file) => [file.name, file]));
    return SKILL_FILE_GUIDE.map((entry) => {
      const file = byName.get(entry.name) ?? null;
      return {
        ...entry,
        file,
        configured: Boolean(file && !file.missing),
      };
    });
  }, [files]);

  const connectedChannels = useMemo(
    () => channels.filter((channel) => channel.connected === true).length,
    [channels],
  );

  const enabledTools = useMemo(
    () => tools.filter((tool) => tool.enabled).length,
    [tools],
  );

  const enabledSkillPacks = useMemo(
    () => skillPacks.filter((skill) => skill.enabled).length,
    [skillPacks],
  );

  const enabledExtensions = useMemo(
    () => extensionPacks.filter((extension) => extension.enabled && extension.globallyEnabled !== false).length,
    [extensionPacks],
  );

  const sortedIntegrationPresets = useMemo(
    () =>
      [...integrationPresets].sort((left, right) => {
        const leftRecommended = selectedAgentRole?.roleType && left.recommendedRoleTypes?.includes(selectedAgentRole.roleType);
        const rightRecommended = selectedAgentRole?.roleType && right.recommendedRoleTypes?.includes(selectedAgentRole.roleType);
        if (leftRecommended && !rightRecommended) return -1;
        if (!leftRecommended && rightRecommended) return 1;
        return left.name.localeCompare(right.name);
      }),
    [integrationPresets, selectedAgentRole],
  );

  const configuredSkillFiles = useMemo(
    () => skillFileEntries.filter((entry) => entry.configured).length,
    [skillFileEntries],
  );

  const orchestratorRole = useMemo(
    () => roles.find((role) => role.roleType === "orchestrator") ?? null,
    [roles],
  );

  const overviewDirty = useMemo(() => {
    if (!selectedAgent) return false;
    return (
      form.name !== selectedAgent.name ||
      form.workspacePath !== selectedAgent.workspacePath ||
      form.modelRef !== (selectedAgent.modelRef ?? "") ||
      form.spendCapUsd !== (selectedAgent.spendCapUsd === null ? "" : String(selectedAgent.spendCapUsd)) ||
      form.spendWindowDays !== String(selectedAgent.spendWindowDays) ||
      form.budgetAction !== selectedAgent.budgetAction ||
      form.isDefault !== selectedAgent.isDefault ||
      form.isActive !== selectedAgent.isActive
    );
  }, [form, selectedAgent]);

  const fileDirty = selectedFileName ? fileDraftContent !== fileBaseContent : false;

  const hasChannelConfig = useMemo(
    () => connectedChannels > 0 || channelWorkflows.length > 0,
    [connectedChannels, channelWorkflows],
  );

  const hasScheduleConfig = useMemo(
    () => cronSummary.totalJobs > 0,
    [cronSummary.totalJobs],
  );

  const comparisonRows = useMemo(() => {
    const roleByAgent = new Map(roles.map((role) => [role.agentId, role]));
    return agents.slice(0, 8).map((agent) => {
      const role = roleByAgent.get(agent.id);
      const budget =
        agent.spendCapUsd === null
          ? "no cap"
          : `${formatUsd(agent.budgetSummary?.spentUsd ?? 0)} / ${formatUsd(agent.spendCapUsd)}`;
      return {
        id: agent.id,
        name: agent.name,
        model: agent.modelRef || "global fallback",
        role: role?.roleTitle || role?.roleType || "unassigned",
        tools: `${agent.disabledTools.length} disabled`,
        channels: agent.isActive ? "eligible" : "inactive",
        budget,
      };
    });
  }, [agents, roles]);

  const tabStatus = useMemo(() => {
    const agentRole = selectedAgentRole;
    return {
      overview: selectedAgent?.name ? "green" : "red",
      tools: enabledTools > 0 ? "green" : "amber",
      skills: enabledSkillPacks + enabledExtensions > 0 ? "green" : "amber",
      channels: hasChannelConfig ? "green" : "amber",
      cron: hasScheduleConfig ? "green" : "muted",
      roles: agentRole ? "green" : "amber",
    } as Record<string, "green" | "amber" | "red" | "muted">;
  }, [selectedAgent, enabledTools, enabledSkillPacks, enabledExtensions, hasChannelConfig, hasScheduleConfig, selectedAgentRole]);

  const dotColor = (status: "green" | "amber" | "red" | "muted") => {
    if (status === "green") return "bg-emerald-500";
    if (status === "amber") return "bg-amber-500";
    if (status === "red") return "bg-red-500";
    return "bg-muted-foreground/30";
  };

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  const loadAgents = useCallback(async (preferredId?: string | null) => {
    setLoadingAgents(true);
    setAgentsError(null);
    try {
      const json = await cachedJson<any>("agents", "/api/agents", APP_TTL.agents);
      if (!json.success) {
        setAgentsError(json.error || "Agent list failed.");
        return;
      }
      const nextAgents = (json.data?.agents ?? []) as AgentRecord[];
      const nextDefault = (json.data?.defaultId as string | null) ?? null;
      setAgents(nextAgents);
      setDefaultId(nextDefault);

      const target =
        (preferredId && nextAgents.some((agent) => agent.id === preferredId) && preferredId) ||
        (selectedAgentId && nextAgents.some((agent) => agent.id === selectedAgentId) && selectedAgentId) ||
        nextDefault ||
        nextAgents[0]?.id ||
        null;
      setSelectedAgentId(target);
    } catch (error) {
      setAgentsError(String(error));
    } finally {
      setLoadingAgents(false);
    }
  }, [selectedAgentId]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const json = await cachedJson<any>("models", "/api/models", APP_TTL.models);
      if (!json.success) return;
      setModels((json.data ?? []) as ModelOption[]);
    } catch {
      // no-op
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async (agentId: string) => {
    setFilesLoading(true);
    try {
      const response = await fetch(`/api/agents/files?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) return;
      const listed = (json.data?.files ?? []) as AgentFile[];
      setFiles(listed);
      if (!selectedFileName || !listed.some((entry) => entry.name === selectedFileName)) {
        setSelectedFileName(listed[0]?.name ?? null);
      }
    } catch {
      // no-op
    } finally {
      setFilesLoading(false);
    }
  }, [selectedFileName]);

  const loadSingleFile = useCallback(async (agentId: string, fileName: string) => {
    setFilesLoading(true);
    try {
      const response = await fetch(
        `/api/agents/files?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(fileName)}`,
      );
      const json = await response.json();
      if (!json.success) return;
      const file = json.data?.file as AgentFile | undefined;
      const content = file?.content ?? "";
      setFileBaseContent(content);
      setFileDraftContent(content);
    } catch {
      // no-op
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const loadTools = useCallback(async (agentId: string) => {
    setToolsLoading(true);
    try {
      const response = await fetch(`/api/agents/skills?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) return;
      setTools((json.data?.tools ?? []) as AgentTool[]);
      setSkillPacks((json.data?.skills ?? []) as AgentSkillPack[]);
      setExtensionPacks((json.data?.extensions ?? []) as AgentExtensionPack[]);
      setIntegrationPresets((json.data?.presets ?? []) as IntegrationPreset[]);
    } catch {
      // no-op
    } finally {
      setToolsLoading(false);
    }
  }, []);

  const loadChannels = useCallback(async (agentId: string) => {
    setChannelsLoading(true);
    try {
      const response = await fetch(`/api/agents/channels?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) return;
      setChannels((json.data?.channels ?? []) as AgentChannelStatus[]);
      setChannelWorkflows((json.data?.workflows ?? []) as AgentChannelWorkflow[]);
    } catch {
      // no-op
    } finally {
      setChannelsLoading(false);
    }
  }, []);

  const loadCron = useCallback(async (agentId: string) => {
    setCronLoading(true);
    try {
      const response = await fetch(`/api/agents/cron?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) return;
      setCronSummary((json.data?.summary ?? {
        totalJobs: 0,
        scheduledJobs: 0,
        activeWorkflows: 0,
      }) as AgentCronSummary);
      setCronJobs((json.data?.jobs ?? []) as AgentCronJob[]);
    } catch {
      // no-op
    } finally {
      setCronLoading(false);
    }
  }, []);

  const loadRoles = useCallback(async () => {
    setRolesLoading(true);
    try {
      const json = await cachedJson<any>("agents/roles", "/api/agents/roles", 15_000);
      if (!json.success) return;
      const nextRoles = (json.data ?? []) as AgentRole[];
      setRoles(nextRoles);
      const nextDrafts: Record<string, AgentRoleDraft> = {};
      for (const role of nextRoles) {
        nextDrafts[role.agentId] = {
          roleType: role.roleType,
          roleTitle: role.roleTitle,
          roleDescription: role.roleDescription,
          reportsTo: role.reportsTo,
          capabilitiesText: role.capabilities.join(", "),
        };
      }
      setRoleDrafts(nextDrafts);
    } catch {
      // no-op
    } finally {
      setRolesLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  // Agents page has no bootstrap endpoint — defer /api/agents and /api/models
  // behind useful-ready so the page shell paints first.
  useAfterUseful(() => {
    void loadAgents();
    void loadModels();
  }, [loadAgents, loadModels]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AGENTS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(AGENTS_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  useEffect(() => {
    const requestedAgent = searchParams.get("agent");
    const requestedTab = searchParams.get("tab") as AgentTab | null;
    if (requestedAgent && agents.some((agent) => agent.id === requestedAgent)) {
      setSelectedAgentId(requestedAgent);
    }
    if (
      requestedTab &&
      ["overview", "files", "tools", "skills", "channels", "cron", "roles"].includes(requestedTab)
    ) {
      setActiveTab(requestedTab);
    }
  }, [agents, searchParams]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", selectedAgentId);
    params.set("tab", activeTab);
    router.replace(`/agents?${params.toString()}`, { scroll: false });
  }, [activeTab, router, searchParams, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgent) {
      setForm(EMPTY_FORM);
      setCustomModelProvider("");
      setCustomModelId("");
      return;
    }
    const modelRef = selectedAgent.modelRef || "";
    const [providerFromRef, modelIdFromRef] = modelRef.includes(":")
      ? modelRef.split(":", 2)
      : ["", ""];
    setForm({
      name: selectedAgent.name,
      icon: (selectedAgent as unknown as Record<string, unknown>).icon as string ?? "Bot",
      workspacePath: selectedAgent.workspacePath,
      modelRef,
      modelApiKey: (selectedAgent as unknown as Record<string, unknown>).modelApiKey as string ?? "",
      modelBaseUrl: (selectedAgent as unknown as Record<string, unknown>).modelBaseUrl as string ?? "",
      systemPrompt: (selectedAgent as unknown as Record<string, unknown>).systemPrompt as string ?? "",
      temperature: (selectedAgent as unknown as Record<string, unknown>).temperature != null
        ? String((selectedAgent as unknown as Record<string, unknown>).temperature)
        : "",
      maxTokens: (selectedAgent as unknown as Record<string, unknown>).maxTokens != null
        ? String((selectedAgent as unknown as Record<string, unknown>).maxTokens)
        : "",
      spendCapUsd:
        selectedAgent.spendCapUsd === null || typeof selectedAgent.spendCapUsd === "undefined"
          ? ""
          : String(selectedAgent.spendCapUsd),
      spendWindowDays: String(selectedAgent.spendWindowDays || 30),
      budgetAction: selectedAgent.budgetAction || "warn",
      budgetMonthlyCents: selectedAgent.budgetMonthlyCents != null ? String(selectedAgent.budgetMonthlyCents) : "",
      isDefault: selectedAgent.isDefault,
      isActive: selectedAgent.isActive,
    });
    setCustomModelProvider(providerFromRef || "google");
    setCustomModelId(modelIdFromRef || "gemini-2.5-flash");
  }, [selectedAgent]);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (activeTab === "files") {
      void loadFiles(selectedAgentId);
    }
    if (activeTab === "tools" || activeTab === "skills") {
      void loadTools(selectedAgentId);
    }
    if (activeTab === "channels") {
      void loadChannels(selectedAgentId);
    }
    if (activeTab === "cron") {
      void loadCron(selectedAgentId);
    }
    if (activeTab === "roles") {
      void loadRoles();
    }
  }, [activeTab, loadChannels, loadCron, loadFiles, loadRoles, loadTools, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId || activeTab !== "files" || !selectedFileName) return;
    void loadSingleFile(selectedAgentId, selectedFileName);
  }, [activeTab, loadSingleFile, selectedAgentId, selectedFileName]);

  // ---------------------------------------------------------------------------
  // Mutation handlers
  // ---------------------------------------------------------------------------
  const onCreateAgent = async () => {
    const name = newAgentName.trim();
    if (!name) return;
    setAgentsError(null);
    setCreating(true);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await response.json();
      if (json.success && json.data?.id) {
        setNewAgentName("");
        invalidateCache(/^agents/);
        await loadAgents(json.data.id as string);
      }
    } catch (error) {
      setAgentsError(String(error));
    } finally {
      setCreating(false);
    }
  };

  const onCreatePresetAgent = async (preset: AgentCreatePreset) => {
    setNewAgentName(preset.label);
    setCreating(true);
    setAgentsError(null);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: preset.label,
          enabledToolsets: preset.enabledToolsets,
          enabledSkills: preset.enabledSkills,
          systemPrompt: preset.systemPrompt,
          temperature: preset.temperature,
          maxTokens: preset.maxTokens,
        }),
      });
      const json = await response.json();
      if (json.success && json.data?.id) {
        await fetch("/api/agents/roles", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: json.data.id,
            roleType: preset.roleType,
            roleTitle: preset.roleTitle,
            roleDescription: preset.roleDescription,
            capabilities: preset.capabilities,
          }),
        });
        setNewAgentName("");
        invalidateCache(/^agents/);
        await loadAgents(json.data.id as string);
        await loadRoles();
      } else {
        setAgentsError(json.error || `Agent creation failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      setAgentsError(String(error));
    } finally {
      setCreating(false);
    }
  };

  const onSaveOverview = async () => {
    if (!selectedAgent) return;
    setSavingOverview(true);
    try {
      await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedAgent.id,
          name: form.name,
          icon: form.icon || "Bot",
          workspacePath: form.workspacePath,
          modelRef: form.modelRef.trim() ? form.modelRef.trim() : null,
          modelApiKey: form.modelApiKey.trim() ? form.modelApiKey.trim() : null,
          modelBaseUrl: form.modelBaseUrl.trim() ? form.modelBaseUrl.trim() : null,
          systemPrompt: form.systemPrompt.trim() ? form.systemPrompt.trim() : null,
          temperature: form.temperature.trim() ? Number(form.temperature) : null,
          maxTokens: form.maxTokens.trim() ? Number(form.maxTokens) : null,
          spendCapUsd: form.spendCapUsd.trim() ? Number(form.spendCapUsd) : null,
          spendWindowDays: Number(form.spendWindowDays || "30"),
          budgetAction: form.budgetAction,
          budgetMonthlyCents: form.budgetMonthlyCents.trim() ? Number(form.budgetMonthlyCents) : null,
          isDefault: form.isDefault,
          isActive: form.isActive,
        }),
      });
      invalidateCache(/^agents/);
      await loadAgents(selectedAgent.id);
    } catch {
      // no-op
    } finally {
      setSavingOverview(false);
    }
  };

  const onDeleteAgent = async () => {
    if (!selectedAgent || selectedAgent.isDefault) return;
    setDeletingAgent(true);
    try {
      await fetch(`/api/agents?id=${encodeURIComponent(selectedAgent.id)}`, { method: "DELETE" });
      invalidateCache(/^agents/);
      await loadAgents();
      setDeleteAgentOpen(false);
    } catch {
      // no-op
    } finally {
      setDeletingAgent(false);
    }
  };

  const onSaveFile = async () => {
    if (!selectedAgent || !selectedFileName) return;
    setSavingFile(true);
    try {
      const response = await fetch("/api/agents/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          name: selectedFileName,
          content: fileDraftContent,
        }),
      });
      const json = await response.json();
      if (json.success) {
        setFileBaseContent(fileDraftContent);
        invalidateCache(/^agents/);
        await loadFiles(selectedAgent.id);
      }
    } catch {
      // no-op
    } finally {
      setSavingFile(false);
    }
  };

  const onToggleTool = async (toolName: string, enabled: boolean) => {
    if (!selectedAgent) return;
    setSavingTools(true);
    setTools((current) =>
      current.map((tool) => (tool.name === toolName ? { ...tool, enabled } : tool)),
    );
    try {
      await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          updates: [{ name: toolName, enabled }],
        }),
      });
    } catch {
      setTools((current) =>
        current.map((tool) =>
          tool.name === toolName ? { ...tool, enabled: !enabled } : tool,
        ),
      );
    } finally {
      setSavingTools(false);
    }
  };

  const setAllTools = async (enabled: boolean) => {
    if (!selectedAgent) return;
    setSavingTools(true);
    const allNames = tools.map((tool) => tool.name);
    setTools((current) => current.map((tool) => ({ ...tool, enabled })));
    try {
      await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          disabledTools: enabled ? [] : allNames,
        }),
      });
    } catch {
      setTools((current) => current.map((tool) => ({ ...tool, enabled: !enabled })));
    } finally {
      setSavingTools(false);
    }
  };

  const onToggleSkillPack = async (skillId: string, enabled: boolean) => {
    if (!selectedAgent) return;
    setSavingTools(true);
    setSkillPacks((current) =>
      current.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill)),
    );
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          skillUpdates: [{ id: skillId, enabled }],
        }),
      });
      const json = await response.json();
      if (json.success) {
        setSkillPacks((json.data?.skills ?? []) as AgentSkillPack[]);
        setExtensionPacks((json.data?.extensions ?? []) as AgentExtensionPack[]);
      }
    } catch {
      setSkillPacks((current) =>
        current.map((skill) => (skill.id === skillId ? { ...skill, enabled: !enabled } : skill)),
      );
    } finally {
      setSavingTools(false);
    }
  };

  const onToggleExtensionPack = async (extensionId: string, enabled: boolean) => {
    if (!selectedAgent) return;
    setSavingTools(true);
    setExtensionPacks((current) =>
      current.map((extension) =>
        extension.id === extensionId ? { ...extension, enabled } : extension,
      ),
    );
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          extensionUpdates: [{ id: extensionId, enabled }],
        }),
      });
      const json = await response.json();
      if (json.success) {
        setSkillPacks((json.data?.skills ?? []) as AgentSkillPack[]);
        setExtensionPacks((json.data?.extensions ?? []) as AgentExtensionPack[]);
      }
    } catch {
      setExtensionPacks((current) =>
        current.map((extension) =>
          extension.id === extensionId ? { ...extension, enabled: !enabled } : extension,
        ),
      );
    } finally {
      setSavingTools(false);
    }
  };

  const applyIntegrationPreset = async (presetId: string, mode: "merge" | "replace" = "merge") => {
    if (!selectedAgent) return;
    setSavingTools(true);
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          presetId,
          presetMode: mode,
        }),
      });
      const json = await response.json();
      if (json.success) {
        setTools((json.data?.tools ?? []) as AgentTool[]);
        setSkillPacks((json.data?.skills ?? []) as AgentSkillPack[]);
        setExtensionPacks((json.data?.extensions ?? []) as AgentExtensionPack[]);
        setIntegrationPresets((json.data?.presets ?? []) as IntegrationPreset[]);
      }
    } finally {
      setSavingTools(false);
    }
  };

  const onChangeRoleDraft = (agentId: string, patch: Partial<AgentRoleDraft>) => {
    setRoleDrafts((current) => {
      const existing = current[agentId];
      if (!existing) return current;
      return {
        ...current,
        [agentId]: {
          ...existing,
          ...patch,
        },
      };
    });
  };

  const onSaveRole = async (agentId: string) => {
    const draft = roleDrafts[agentId];
    if (!draft) return;
    setSavingRoleId(agentId);
    try {
      await fetch("/api/agents/roles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          roleType: draft.roleType,
          roleTitle: draft.roleTitle.trim(),
          roleDescription: draft.roleDescription.trim(),
          reportsTo: draft.roleType === "orchestrator" ? null : draft.reportsTo,
          capabilities: draft.capabilitiesText
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      invalidateCache(/^agents/);
      await loadRoles();
    } catch {
      // no-op
    } finally {
      setSavingRoleId(null);
    }
  };

  const onSetOrchestrator = async (agentId: string) => {
    setSavingRoleId(agentId);
    try {
      await fetch("/api/agents/roles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          roleType: "orchestrator",
          reportsTo: null,
        }),
      });
      invalidateCache(/^agents/);
      await loadRoles();
    } catch {
      // no-op
    } finally {
      setSavingRoleId(null);
    }
  };

  const onChangeModelMode = (mode: "global" | "configured" | "custom") => {
    if (mode === "global") {
      setForm((current) => ({ ...current, modelRef: "" }));
      return;
    }
    if (mode === "configured") {
      const fallback = activeModelOptions[0]?.id || "";
      setForm((current) => ({ ...current, modelRef: fallback }));
      return;
    }
    const provider = customModelProvider.trim() || "google";
    const modelId = customModelId.trim() || "gemini-2.5-flash";
    setCustomModelProvider(provider);
    setCustomModelId(modelId);
    setForm((current) => ({ ...current, modelRef: `${provider}:${modelId}` }));
  };

  const onSelectConfiguredModel = (id: string) => {
    setForm((current) => ({ ...current, modelRef: id }));
  };

  const onCustomModelProviderChange = (value: string) => {
    setCustomModelProvider(value);
    const provider = value.trim();
    const providerInfo = PROVIDERS.find((entry) => entry.id === provider);
    const providerDefault = providerInfo?.defaultModel ?? "gemini-2.5-flash";
    const previousDefault = PROVIDERS.find((entry) => entry.id === customModelProvider.trim())?.defaultModel;
    const modelId =
      !customModelId.trim() || customModelId.trim() === previousDefault
        ? providerDefault
        : customModelId.trim();
    setCustomModelId(modelId);
    if (!provider || !modelId) return;
    setForm((current) => ({ ...current, modelRef: `${provider}:${modelId}` }));
  };

  const onCustomModelIdChange = (value: string) => {
    setCustomModelId(value);
    const provider = customModelProvider.trim();
    const modelId = value.trim();
    if (!provider || !modelId) return;
    setForm((current) => ({ ...current, modelRef: `${provider}:${modelId}` }));
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
<main className="flex-1 overflow-auto p-6" data-perf-ready="agents">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Agents</h1>
              <p className="text-sm text-muted-foreground">
                Create agents here, then tune each agent&apos;s files, tools, skills, channels, scheduler, and role behavior.
              </p>
            </div>
            <Badge variant="outline">{agents.length} agents</Badge>
          </div>

          {searchParams.get("intent") === "template-agent-required" ? (
            <Card className="mb-4 border-yellow-500/40 bg-yellow-500/5">
              <CardContent className="py-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold">You were sent here from the Workflows tab.</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      The template you chose requires at least one active agent. Create an agent below, then return to the Workflows tab to use the template.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => router.push("/workflows?tab=templates")}>
                    Back to Templates
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {comparisonRows.length > 0 ? (
            <Card className="mb-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Agent Comparison</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2 lg:grid-cols-4 xl:grid-cols-8">
                  {comparisonRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setSelectedAgentId(row.id)}
                      className={`rounded-md border p-3 text-left transition ${
                        selectedAgentId === row.id ? "border-primary bg-muted/50" : "hover:bg-muted/40"
                      }`}
                    >
                      <div className="truncate text-sm font-semibold">{row.name}</div>
                      <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                        <div className="truncate">Model: {row.model}</div>
                        <div className="truncate">Role: {row.role}</div>
                        <div className="truncate">Tools: {row.tools}</div>
                        <div className="truncate">Channels: {row.channels}</div>
                        <div className="truncate">Budget: {row.budget}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <AgentSidebar
              agents={agents}
              defaultId={defaultId}
              selectedAgentId={selectedAgentId}
              setSelectedAgentId={setSelectedAgentId}
              loadingAgents={loadingAgents}
              agentsError={agentsError}
              hideGettingStarted={hideGettingStarted}
              setHideGettingStarted={setHideGettingStarted}
              newAgentName={newAgentName}
              setNewAgentName={setNewAgentName}
              creating={creating}
              onCreateAgent={onCreateAgent}
              onCreatePresetAgent={onCreatePresetAgent}
              loadAgents={loadAgents}
            />

            <div className="space-y-4">
              {!selectedAgent ? (
                <Card>
                  <CardContent className="py-10">
                    <div className="max-w-xl space-y-4">
                      <div>
                        <h2 className="text-lg font-semibold">No agent selected</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Select an agent or create one from the left panel. Agent-backed workflow templates use this pool when they ask for workers.
                        </p>
                      </div>
                      <div className="grid gap-2 text-sm sm:grid-cols-3">
                        <div className="rounded-md border border-border p-3">
                          <div className="font-medium">1. Create</div>
                          <p className="mt-1 text-xs text-muted-foreground">Start with a research, workflow, or review agent.</p>
                        </div>
                        <div className="rounded-md border border-border p-3">
                          <div className="font-medium">2. Configure</div>
                          <p className="mt-1 text-xs text-muted-foreground">Choose model, tools, files, budget, and channels.</p>
                        </div>
                        <div className="rounded-md border border-border p-3">
                          <div className="font-medium">3. Use</div>
                          <p className="mt-1 text-xs text-muted-foreground">Assign it to workflows, hierarchy, and council runs.</p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <ShapeAvatar seed={selectedAgent.id} size={34} />
                          <div className="min-w-0">
                            <CardTitle className="truncate text-lg">{selectedAgent.name}</CardTitle>
                            <p className="truncate text-xs text-muted-foreground">{selectedAgent.id}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedAgent.id === defaultId ? <Badge variant="secondary">default</Badge> : null}
                          {!selectedAgent.isActive ? <Badge variant="outline">inactive</Badge> : null}
                          {overviewDirty ? <Badge variant="outline">unsaved overview</Badge> : null}
                          {fileDirty ? <Badge variant="outline">unsaved file</Badge> : null}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleteAgentOpen(true)}
                            disabled={selectedAgent.isDefault}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>

                  <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AgentTab)}>
                    <TabsList className="grid w-full grid-cols-3 gap-1 lg:grid-cols-7">
                      {(["overview", "files", "tools", "skills", "channels", "cron", "roles"] as AgentTab[]).map((key) => (
                        <TabsTrigger key={key} value={key} className="flex items-center gap-1">
                          {key === "overview" ? "Overview" : key === "files" ? "Files" : key === "tools" ? "Tools" : key === "skills" ? "Skills" : key === "channels" ? "Channels" : key === "cron" ? "Scheduler" : "Roles"}
                          <span className={`ml-1.5 h-1.5 w-1.5 rounded-full ${dotColor(tabStatus[key])}`} />
                        </TabsTrigger>
                      ))}
                    </TabsList>

                    <TabsContent value="overview">
                      <AgentOverview
                        selectedAgent={selectedAgent}
                        form={form}
                        setForm={setForm}
                        activeModelOptions={activeModelOptions}
                        hasConfiguredModelRef={hasConfiguredModelRef}
                        modelMode={modelMode}
                        customModelProvider={customModelProvider}
                        setCustomModelProvider={setCustomModelProvider}
                        customModelId={customModelId}
                        setCustomModelId={setCustomModelId}
                        modelsLoading={modelsLoading}
                        savingOverview={savingOverview}
                        overviewDirty={overviewDirty}
                        selectedAgentRole={selectedAgentRole}
                        toolsCount={tools.length}
                        enabledTools={enabledTools}
                        enabledSkillPacks={enabledSkillPacks}
                        enabledExtensions={enabledExtensions}
                        channelWorkflows={channelWorkflows}
                        connectedChannels={connectedChannels}
                        onChangeModelMode={onChangeModelMode}
                        onSelectConfiguredModel={onSelectConfiguredModel}
                        onCustomModelProviderChange={onCustomModelProviderChange}
                        onCustomModelIdChange={onCustomModelIdChange}
                        onSaveOverview={onSaveOverview}
                        loadModels={loadModels}
                        hasChannelConfig={hasChannelConfig}
                        hasScheduleConfig={hasScheduleConfig}
                      />
                    </TabsContent>

                    <TabsContent value="files">
                      <AgentFiles
                        files={files}
                        filesLoading={filesLoading}
                        selectedFileName={selectedFileName}
                        setSelectedFileName={setSelectedFileName}
                        fileBaseContent={fileBaseContent}
                        fileDraftContent={fileDraftContent}
                        setFileDraftContent={setFileDraftContent}
                        fileDirty={fileDirty}
                        savingFile={savingFile}
                        onSaveFile={onSaveFile}
                      />
                    </TabsContent>

                    <TabsContent value="tools">
                      <AgentTools
                        tools={tools}
                        toolsLoading={toolsLoading}
                        savingTools={savingTools}
                        toolFilter={toolFilter}
                        setToolFilter={setToolFilter}
                        filteredTools={filteredTools}
                        enabledTools={enabledTools}
                        onToggleTool={onToggleTool}
                        setAllTools={setAllTools}
                      />
                    </TabsContent>

                    <TabsContent value="skills">
                      <AgentSkills
                        skillPacks={skillPacks}
                        extensionPacks={extensionPacks}
                        integrationPresets={integrationPresets}
                        toolsLoading={toolsLoading}
                        filesLoading={filesLoading}
                        savingTools={savingTools}
                        enabledSkillPacks={enabledSkillPacks}
                        enabledExtensions={enabledExtensions}
                        configuredSkillFiles={configuredSkillFiles}
                        sortedIntegrationPresets={sortedIntegrationPresets}
                        skillFileEntries={skillFileEntries}
                        files={files}
                        selectedAgentRole={selectedAgentRole}
                        selectedAgentId={selectedAgentId}
                        onToggleSkillPack={onToggleSkillPack}
                        onToggleExtensionPack={onToggleExtensionPack}
                        applyIntegrationPreset={applyIntegrationPreset}
                        loadTools={loadTools}
                        loadFiles={loadFiles}
                        setSelectedFileName={setSelectedFileName}
                        setActiveTab={setActiveTab}
                      />
                    </TabsContent>

                    <TabsContent value="channels">
                      <AgentChannels
                        channels={channels}
                        channelWorkflows={channelWorkflows}
                        channelsLoading={channelsLoading}
                        connectedChannels={connectedChannels}
                        selectedAgentId={selectedAgentId}
                        loadChannels={loadChannels}
                      />
                    </TabsContent>

                    <TabsContent value="cron">
                      <AgentScheduler
                        cronSummary={cronSummary}
                        cronJobs={cronJobs}
                        cronLoading={cronLoading}
                        selectedAgentId={selectedAgentId}
                        loadCron={loadCron}
                      />
                    </TabsContent>

                    <TabsContent value="roles">
                      <AgentRoles
                        roles={roles}
                        roleDrafts={roleDrafts}
                        rolesLoading={rolesLoading}
                        savingRoleId={savingRoleId}
                        orchestratorRole={orchestratorRole}
                        selectedAgentId={selectedAgentId}
                        onChangeRoleDraft={onChangeRoleDraft}
                        onSaveRole={onSaveRole}
                        onSetOrchestrator={onSetOrchestrator}
                        loadRoles={loadRoles}
                      />
                    </TabsContent>
                  </Tabs>
                </>
              )}
            </div>
          </div>
          <Dialog open={deleteAgentOpen} onOpenChange={setDeleteAgentOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Agent</DialogTitle>
                <DialogDescription>
                  Delete &quot;{selectedAgent?.name ?? "this agent"}&quot; and its local runtime state. Workflows, boards, and roles that referenced it may need reassignment.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteAgentOpen(false)} disabled={deletingAgent}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void onDeleteAgent()} disabled={deletingAgent || selectedAgent?.isDefault}>
                  {deletingAgent ? "Deleting..." : "Delete Agent"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
  );
}
