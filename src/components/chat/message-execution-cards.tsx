"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Globe2, Users, Brain, Wrench, Workflow } from "lucide-react";
import type { ChatMessage } from "@/types/channel";

function readPendingAppActionPlan(message: ChatMessage): {
  version: number;
  confidence: number;
  userIntent: string;
  requiresConfirmation: boolean;
  assumptions: string[];
  steps: Array<{
    id: string;
    action: string;
    label: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
  }>;
} | null {
  const value = message.metadata?.pendingAppActionPlan as unknown;
  if (!value || typeof value !== "object") return null;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.steps)) return null;
  return {
    version: Number(plan.version) || 1,
    confidence: Number(plan.confidence) || 0.7,
    userIntent: String(plan.userIntent || ""),
    requiresConfirmation: plan.requiresConfirmation !== false,
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
    steps: (plan.steps as Array<Record<string, unknown>>).map((step, index) => {
      const params = step.params && typeof step.params === "object" && !Array.isArray(step.params)
        ? step.params as Record<string, unknown>
        : {};
      return {
        id: String(step.id || `step-${index + 1}`),
        action: String(step.action || "summarize_state"),
        label: String(step.label || `Step ${index + 1}`),
        params,
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String).filter(Boolean) : undefined,
      };
    }),
  };
}

export function MessageExecutionCards({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  if (message.role === "user") return null;
  const metadata = message.metadata ?? {};
  const provenance = message.provenance ?? {};
  const routeSource = String(provenance.routeSource ?? metadata.routeSource ?? "").trim();
  const workflowName = String(metadata.workflowName ?? provenance.workflowName ?? "").trim();
  const workflowId = String(metadata.workflowId ?? provenance.workflowId ?? "").trim();
  const selectedContext = metadata.selectedContext && typeof metadata.selectedContext === "object"
    ? metadata.selectedContext as Record<string, unknown>
    : null;
  const blocked = metadata.toolModeBlocked === true;
  const executionSummary = metadata.executionSummary && typeof metadata.executionSummary === "object"
    ? metadata.executionSummary as {
      executionId?: string;
      status?: string;
      counts?: Record<string, number>;
      entries?: Array<{
        nodeId?: string;
        type?: string;
        label?: string;
        category?: string;
        status?: string;
        durationMs?: number | null;
        summary?: string;
      }>;
    }
    : null;
  const sessionSnapshot = metadata.sessionSnapshot && typeof metadata.sessionSnapshot === "object"
    ? metadata.sessionSnapshot as Record<string, unknown>
    : null;
  const learningFeedback = metadata.learningFeedback && typeof metadata.learningFeedback === "object"
    ? metadata.learningFeedback as Record<string, unknown>
    : null;
  const cards: Array<{ title: string; rows: Array<[string, string]>; tone?: "warning" | "default"; detail?: string; kind?: string }> = [];
  if (routeSource || workflowName || workflowId) {
    cards.push({
      title: blocked ? "Tool Policy" : "Route",
      tone: blocked ? "warning" : "default",
      kind: blocked ? "tool" : "workflow",
      rows: [
        ["source", routeSource || "unknown"],
        ["workflow", workflowName || workflowId || "none"],
      ],
    });
  }
  if (selectedContext) {
    cards.push({
      title: "Selected Context",
      kind: "memory",
      rows: [
        ["agent", String(selectedContext.agentId ?? "default")],
        ["model", String(selectedContext.modelRef ?? "inherit")],
        ["tools", String(selectedContext.toolMode ?? "default")],
        ["workspace", String(selectedContext.workspacePath ?? "default")],
        ["speed", selectedContext.fastMode === true ? "fast" : selectedContext.fastMode === false ? "standard" : "auto"],
      ],
    });
  }
  const plan = readPendingAppActionPlan(message);
  if (plan) {
    cards.push({
      title: "Pending Plan",
      kind: "workflow",
      rows: [
        ["steps", String(plan.steps.length)],
        ["confidence", `${Math.round(plan.confidence * 100)}%`],
      ],
    });
  }
  if (executionSummary) {
    const counts = executionSummary.counts ?? {};
    const entries = Array.isArray(executionSummary.entries) ? executionSummary.entries : [];
    const categoryLabels: Array<[string, string]> = [
      ["browser", "Browser"],
      ["council", "Council"],
      ["memory", "Memory"],
      ["tool", "Tools"],
    ];
    for (const [category, title] of categoryLabels) {
      const scoped = entries.filter((entry) => entry.category === category);
      if (scoped.length === 0 && !counts[category]) continue;
      cards.push({
        title,
        kind: category,
        rows: [
          ["nodes", String(counts[category] ?? scoped.length)],
          ["status", String(executionSummary.status ?? "completed")],
        ],
        detail: scoped
          .slice(0, 4)
          .map((entry) => {
            const duration = typeof entry.durationMs === "number" ? ` · ${Math.round(entry.durationMs)}ms` : "";
            return `${entry.label || entry.nodeId || entry.type || "node"}${duration}: ${entry.summary || entry.status || "completed"}`;
          })
          .join("\n"),
      });
    }
    const other = entries.filter((entry) => !["browser", "council", "memory", "tool"].includes(String(entry.category)));
    if (other.length > 0) {
      cards.push({
        title: "Workflow Steps",
        kind: "workflow",
        rows: [
          ["nodes", String(other.length)],
          ["execution", String(executionSummary.executionId ?? "latest")],
        ],
        detail: other.slice(0, 4).map((entry) => `${entry.label || entry.nodeId || "node"}: ${entry.summary || entry.status || "completed"}`).join("\n"),
      });
    }
  }
  if (sessionSnapshot) {
    const sourceFiles = Array.isArray(sessionSnapshot.sourceFiles) ? sessionSnapshot.sourceFiles.length : 0;
    const snippets = Array.isArray(sessionSnapshot.snippets) ? sessionSnapshot.snippets.length : 0;
    if (sourceFiles || snippets) {
      cards.push({
        title: "Memory Snapshot",
        kind: "memory",
        rows: [
          ["files", String(sourceFiles)],
          ["snippets", String(snippets)],
        ],
      });
    }
  }
  if (learningFeedback?.text) {
    cards.push({
      title: "Learning",
      kind: "memory",
      rows: [["items", String(Array.isArray(learningFeedback.items) ? learningFeedback.items.length : 1)]],
      detail: String(learningFeedback.text).slice(0, 500),
    });
  }
  if (cards.length === 0) return null;

  const iconForCard = (kind?: string) => {
    if (kind === "browser") return <Globe2 className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
    if (kind === "council") return <Users className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
    if (kind === "memory") return <Brain className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
    if (kind === "tool") return <Wrench className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
    return <Workflow className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {expanded ? "Hide" : "Show"} execution details ({cards.length} step{cards.length === 1 ? "" : "s"})
      </button>
      {expanded ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {cards.map((card) => (
            <div
              key={card.title}
              className={`rounded-md border px-3 py-2 text-xs ${card.tone === "warning" ? "border-yellow-500/40 bg-yellow-500/5" : "bg-background/60"}`}
            >
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
                {iconForCard(card.kind)}
                {card.title}
              </div>
              <div className="space-y-1">
                {card.rows.map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate text-foreground" title={value}>{value}</span>
                  </div>
                ))}
              </div>
              {card.detail ? (
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  {card.detail}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
