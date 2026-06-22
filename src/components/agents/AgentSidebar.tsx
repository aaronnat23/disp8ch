"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { AgentRecord, formatUsd } from "./types";
import { Bot, FolderOpen, Globe, MessageSquare, Search, Workflow } from "lucide-react";

export type AgentCreatePreset = {
  key: string;
  label: string;
  icon: string;
  roleType: "orchestrator" | "operations" | "specialist" | "worker" | "support";
  roleTitle: string;
  roleDescription: string;
  capabilities: string[];
  description: string;
  enabledToolsets: string[];
  enabledSkills: string[];
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
};

const AGENT_PRESETS: AgentCreatePreset[] = [
  { 
    key: "chat", label: "Chat Assistant", icon: "MessageSquare",
    roleType: "support",
    roleTitle: "Assistant",
    roleDescription: "Handles general user questions, chat replies, and lightweight coordination.",
    capabilities: ["chat", "memory recall", "task handoff"],
    description: "General-purpose chat agent for conversations and Q&A",
    enabledToolsets: ["memory", "messaging"],
    enabledSkills: ["summarize"],
    systemPrompt: "You are a concise chat assistant for disp8ch. Answer directly, use memory when relevant, and hand work off to workflows or boards when the user asks for operational follow-up.",
    temperature: 0.4,
  },
  { 
    key: "runner", label: "Workflow Runner", icon: "Workflow",
    roleType: "operations",
    roleTitle: "Operator",
    roleDescription: "Runs, monitors, and explains workflow automation.",
    capabilities: ["workflow execution", "schedule inspection", "board handoff"],
    description: "Executes workflows and automation tasks",
    enabledToolsets: ["workflows", "boards", "memory"],
    enabledSkills: ["board-ops"],
    systemPrompt: "You are a workflow operator. Prefer existing workflows and templates, explain planned automation steps before risky changes, and create board follow-ups when work needs tracking.",
    temperature: 0.3,
  },
  { 
    key: "research", label: "Research Analyst", icon: "Search",
    roleType: "specialist",
    roleTitle: "Analyst",
    roleDescription: "Researches documents, memory, and web sources, then synthesizes findings.",
    capabilities: ["document analysis", "web research", "memory synthesis"],
    description: "Searches web, analyzes documents, synthesizes findings",
    enabledToolsets: ["web", "memory", "filesystem"],
    enabledSkills: ["document-intelligence", "document-ingestion-operator"],
    systemPrompt: "You are a research analyst. Gather evidence from approved sources, separate facts from assumptions, cite source context when possible, and produce concise recommendations.",
    temperature: 0.25,
  },
  { 
    key: "workspace", label: "Workspace Operator", icon: "FolderOpen",
    roleType: "worker",
    roleTitle: "Operator",
    roleDescription: "Inspects and organizes local workspace context while avoiding destructive actions.",
    capabilities: ["workspace inspection", "file context", "memory lookup"],
    description: "Reads, writes, and organizes local workspace files",
    enabledToolsets: ["filesystem", "memory"],
    enabledSkills: ["document-intelligence"],
    systemPrompt: "You are a local workspace operator. Inspect files carefully, summarize changes before proposing edits, and avoid destructive actions unless the user explicitly approves them.",
    temperature: 0.2,
  },
  { 
    key: "integration", label: "Integration Agent", icon: "Globe",
    roleType: "operations",
    roleTitle: "Operator",
    roleDescription: "Connects channels, APIs, boards, and workflows with clear safety boundaries.",
    capabilities: ["API coordination", "channel routing", "workflow integration"],
    description: "Connects to external APIs and services",
    enabledToolsets: ["web", "messaging", "workflows", "boards"],
    enabledSkills: ["api-regression-runner", "board-ops"],
    systemPrompt: "You are an integration operator. Connect systems through existing channel, workflow, and board tools; surface credentials or access gaps clearly; never expose secrets.",
    temperature: 0.25,
  },
];

const PRESET_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Bot,
  FolderOpen,
  Globe,
  MessageSquare,
  Search,
  Workflow,
};

export function AgentSidebar({
  agents,
  defaultId,
  selectedAgentId,
  setSelectedAgentId,
  loadingAgents,
  agentsError,
  hideGettingStarted,
  setHideGettingStarted,
  newAgentName,
  setNewAgentName,
  creating,
  onCreateAgent,
  onCreatePresetAgent,
  loadAgents,
}: {
  agents: AgentRecord[];
  defaultId: string | null;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  loadingAgents: boolean;
  agentsError: string | null;
  hideGettingStarted: boolean;
  setHideGettingStarted: (v: boolean) => void;
  newAgentName: string;
  setNewAgentName: (v: string) => void;
  creating: boolean;
  onCreateAgent: () => Promise<void>;
  onCreatePresetAgent: (preset: AgentCreatePreset) => Promise<void>;
  loadAgents: (preferredId?: string | null) => Promise<void>;
}) {
  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Agent List</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            value={newAgentName}
            placeholder="New agent name"
            onChange={(event) => setNewAgentName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void onCreateAgent();
              }
            }}
          />
          <Button size="sm" onClick={onCreateAgent} disabled={creating || !newAgentName.trim()}>
            {creating ? "..." : "Add"}
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadAgents()}>
          Refresh
        </Button>
        {agentsError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            Agent API error: {agentsError}
          </div>
        ) : null}
        <div className="space-y-2">
          {loadingAgents ? (
            <p className="text-sm text-muted-foreground">Loading agents...</p>
            ) : agents.length === 0 ? (
            hideGettingStarted ? (
              <div className="rounded-md border border-dashed px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">No agents yet.</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHideGettingStarted(false)}
                  >
                    Show Tips
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/20 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">First Agent</div>
                    <p className="mt-1 text-sm font-medium">Create an agent to unlock agent-slot templates, councils, and hierarchy work.</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHideGettingStarted(true)}
                  >
                    Hide Tips
                  </Button>
                </div>
                <div className="text-xs font-medium text-muted-foreground">Create from preset</div>
                <div className="grid gap-2">
                  {AGENT_PRESETS.map((preset) => {
                    const Icon = PRESET_ICONS[preset.icon];
                    return (
                      <button
                        key={preset.key}
                        className="flex items-start gap-3 rounded-md border p-3 text-left hover:bg-muted/50 transition-colors"
                        disabled={creating}
                        onClick={() => void onCreatePresetAgent(preset)}
                      >
                        {Icon ? <Icon className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" /> : null}
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{preset.label}</div>
                          <div className="text-xs text-muted-foreground">{preset.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="text-xs text-muted-foreground text-center">or name your own</div>
              </div>
            )
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedAgentId(agent.id)}
                className={`w-full rounded-md border px-3 py-2 text-left transition ${
                  selectedAgentId === agent.id ? "border-primary bg-muted/50" : "hover:bg-muted/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShapeAvatar seed={agent.id} size={28} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-sm">{agent.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{agent.id}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {agent.budgetSummary?.spendCapUsd !== null ? (
                          <Badge
                            variant={
                              agent.budgetSummary?.overCap
                                ? "destructive"
                                : agent.budgetSummary?.warningLevel === "near"
                                  ? "outline"
                                  : "secondary"
                            }
                            className="text-[10px]"
                          >
                            {formatUsd(agent.budgetSummary?.spentUsd ?? 0)} / {formatUsd(agent.budgetSummary?.spendCapUsd)}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">No cap</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {agent.id === defaultId ? <Badge variant="secondary">default</Badge> : null}
                    {!agent.isActive ? <Badge variant="outline">inactive</Badge> : null}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
