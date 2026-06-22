"use client";

import React, { useState, useCallback } from "react";
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import { nanoid } from "nanoid";

type WizardStep<T extends Record<string, unknown> = Record<string, unknown>> = {
  label: string;
  fields: Array<{
    key: string;
    label: string;
    type: "text" | "select" | "cron" | "timezone" | "textarea" | "number";
    required?: boolean;
    options?: Array<{ label: string; value: string }>;
    placeholder?: string;
    defaultValue?: unknown;
  }>;
};

type WizardDefinition = {
  id: string;
  name: string;
  description: string;
  steps: WizardStep[];
  buildGraph: (config: Record<string, unknown>) => { nodes: WorkflowNode[]; edges: WorkflowEdge[]; notes: string[] };
};

const WIZARDS: WizardDefinition[] = [
  {
    id: "daily-webchat-digest",
    name: "Daily WebChat Digest",
    description: "Scheduled workflow that collects information and delivers a daily digest",
    steps: [
      {
        label: "Schedule",
        fields: [
          { key: "cronExpression", label: "Cron Schedule", type: "cron", required: true, defaultValue: "0 9 * * *", placeholder: "0 9 * * *" },
          { key: "timezone", label: "Timezone", type: "timezone", required: true, defaultValue: "UTC" },
        ],
      },
      {
        label: "Sources",
        fields: [
          { key: "sourceType", label: "Source", type: "select", options: [
            { label: "Web Search", value: "web-search" },
            { label: "RSS/HTTP", value: "http" },
            { label: "Memory Recall", value: "memory" },
            { label: "Document Search", value: "document" },
          ], required: true, defaultValue: "web-search" },
          { key: "sourceQuery", label: "Query / URL", type: "text", placeholder: "AI agent news" },
        ],
      },
      {
        label: "Summary Style",
        fields: [
          { key: "summaryLength", label: "Summary Length", type: "select", options: [
            { label: "Brief (3-5 bullets)", value: "brief" },
            { label: "Standard (1 paragraph)", value: "standard" },
            { label: "Detailed (3 paragraphs)", value: "detailed" },
          ], defaultValue: "standard" },
          { key: "includeLinks", label: "Include Source Links", type: "select", options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ], defaultValue: "yes" },
        ],
      },
    ],
    buildGraph: (config) => {
      const nodes: WorkflowNode[] = [];
      const edges: WorkflowEdge[] = [];
      const notes: string[] = [];

      // Trigger
      const triggerId = nanoid();
      nodes.push({
        id: triggerId, type: "cron-trigger", position: { x: 100, y: 100 },
        data: { label: "Daily Digest Trigger", expression: String(config.cronExpression || "0 9 * * *"), timezone: String(config.timezone || "UTC") },
      });

      // Memory recall
      const memId = nanoid();
      nodes.push({
        id: memId, type: "memory-recall", position: { x: 100, y: 250 },
        data: { label: "Recall Context", query: String(config.sourceQuery || ""), limit: 5 },
      });
      edges.push({ id: nanoid(), source: triggerId, target: memId, sourceHandle: "output" });

      // AI Agent
      const agentId = nanoid();
      const lengthPrompt = config.summaryLength === "brief" ? "3-5 bullets" : config.summaryLength === "detailed" ? "3 paragraphs" : "1 paragraph";
      const linkNote = config.includeLinks === "no" ? " Do not include links." : " Include source links.";
      nodes.push({
        id: agentId, type: "claude-agent", position: { x: 100, y: 400 },
        data: {
          label: "Synthesize Digest",
          systemPrompt: [
            `You are a daily digest assistant for disp8ch AI.`,
            `Search for the latest information about: ${config.sourceQuery || "AI agent news"}.`,
            `Produce a ${lengthPrompt} summary.${linkNote}`,
            `Format the digest with a clear heading and clean structure.`,
          ].join("\n"),
          temperature: 0.5,
        },
      });
      edges.push({ id: nanoid(), source: memId, target: agentId, sourceHandle: "output" });

      // Send
      const sendId = nanoid();
      nodes.push({
        id: sendId, type: "send-webchat", position: { x: 100, y: 550 },
        data: { label: "Deliver Digest", message: "{{agent.response}}" },
      });
      edges.push({ id: nanoid(), source: agentId, target: sendId, sourceHandle: "output" });

      notes.push("Cron trigger fires daily at the configured time.");
      notes.push("Memory recall loads relevant context for the query.");
      notes.push("AI Agent synthesizes the digest from recall results.");
      notes.push("Send WebChat delivers the final digest to you.");

      return { nodes, edges, notes };
    },
  },
  {
    id: "api-monitor",
    name: "API Monitor",
    description: "Monitor an API endpoint and alert on failures",
    steps: [
      {
        label: "Monitor Target",
        fields: [
          { key: "url", label: "API URL", type: "text", required: true, placeholder: "https://api.example.com/health" },
          { key: "checkInterval", label: "Check Every", type: "select", options: [
            { label: "1 minute", value: "*/1 * * * *" },
            { label: "5 minutes", value: "*/5 * * * *" },
            { label: "15 minutes", value: "*/15 * * * *" },
            { label: "30 minutes", value: "*/30 * * * *" },
            { label: "1 hour", value: "0 * * * *" },
          ], defaultValue: "*/5 * * * *" },
        ],
      },
      {
        label: "Alert Condition",
        fields: [
          { key: "expectedStatus", label: "Expected Status", type: "number", defaultValue: 200 },
          { key: "conditionBody", label: "Body Condition (optional)", type: "text", placeholder: 'status == "ok"' },
        ],
      },
    ],
    buildGraph: (config) => {
      const nodes: WorkflowNode[] = [];
      const edges: WorkflowEdge[] = [];
      const notes: string[] = [];

      const triggerId = nanoid();
      nodes.push({
        id: triggerId, type: "cron-trigger", position: { x: 100, y: 100 },
        data: { label: "API Monitor Trigger", expression: String(config.checkInterval || "*/5 * * * *") },
      });

      const httpId = nanoid();
      nodes.push({
        id: httpId, type: "http-request", position: { x: 100, y: 250 },
        data: { label: "Check API", url: String(config.url || ""), method: "GET", timeoutMs: 30000 },
      });
      edges.push({ id: nanoid(), source: triggerId, target: httpId, sourceHandle: "output" });

      const ifId = nanoid();
      const conditionBody = String(config.conditionBody || "").trim();
      const condition = conditionBody
        ? `http.status == ${config.expectedStatus || 200} && ${conditionBody}`
        : `http.status == ${config.expectedStatus || 200}`;
      nodes.push({
        id: ifId, type: "if-else", position: { x: 100, y: 400 },
        data: { label: "Check Health", condition },
      });
      edges.push({ id: nanoid(), source: httpId, target: ifId, sourceHandle: "success" });
      edges.push({ id: nanoid(), source: httpId, target: ifId, sourceHandle: "error" });

      const alertId = nanoid();
      nodes.push({
        id: alertId, type: "send-webchat", position: { x: 300, y: 500 },
        data: { label: "Alert", message: `ALERT: API {{nodes.check_api.http_status}} returned status {{http.status}}. URL: ${config.url}` },
      });
      edges.push({ id: nanoid(), source: ifId, target: alertId, sourceHandle: "false" });

      notes.push("Cron trigger checks the API at the configured interval.");
      notes.push("HTTP Request calls the monitored endpoint.");
      notes.push("If/Else checks status against expected value; alerts on mismatch.");
      notes.push("Both success and error edges feed into If/Else for complete coverage.");

      return { nodes, edges, notes };
    },
  },
  {
    id: "github-issue-triage",
    name: "GitHub Issue Triage",
    description: "Monitor GitHub issues and create board tasks",
    steps: [
      {
        label: "Repository",
        fields: [
          { key: "repoOwner", label: "Repository Owner", type: "text", required: true, placeholder: "my-org" },
          { key: "repoName", label: "Repository Name", type: "text", required: true, placeholder: "my-repo" },
          { key: "labelFilter", label: "Label Filter", type: "text", placeholder: "bug" },
        ],
      },
      {
        label: "Board Destination",
        fields: [
          { key: "severityOverride", label: "Severity for Board Tasks", type: "select", options: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ], defaultValue: "medium" },
        ],
      },
    ],
    buildGraph: (config) => {
      const nodes: WorkflowNode[] = [];
      const edges: WorkflowEdge[] = [];
      const notes: string[] = [];

      const triggerId = nanoid();
      nodes.push({
        id: triggerId, type: "cron-trigger", position: { x: 100, y: 100 },
        data: { label: "GitHub Issue Monitor", expression: "0 */6 * * *" },
      });

      const httpId = nanoid();
      const apiUrl = `https://api.github.com/repos/${config.repoOwner || "owner"}/${config.repoName || "repo"}/issues?labels=${config.labelFilter || ""}&state=open`;
      nodes.push({
        id: httpId, type: "http-request", position: { x: 100, y: 250 },
        data: { label: "Fetch Issues", url: apiUrl, method: "GET", headers: { Accept: "application/vnd.github.v3+json" } },
      });
      edges.push({ id: nanoid(), source: triggerId, target: httpId });

      const boardId = nanoid();
      nodes.push({
        id: boardId, type: "board-task", position: { x: 100, y: 400 },
        data: { label: "Create Task for Issues", title: "GitHub Issue: {{item.title}}", priority: String(config.severityOverride || "medium") },
      });
      edges.push({ id: nanoid(), source: httpId, target: boardId });

      notes.push("Cron trigger checks repository every 6 hours.");
      notes.push("HTTP Request fetches open issues from GitHub API.");
      notes.push("Board Task creates a task per matching issue. Requires GITHUB_TOKEN.");

      return { nodes, edges, notes };
    },
  },
];

type WizardFormData = Record<string, unknown>;

export function WorkflowWizard({ onGenerate, onClose }: {
  onGenerate: (result: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; notes: string[]; wizardId: string }) => void;
  onClose: () => void;
}) {
  const [selectedWizard, setSelectedWizard] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<WizardFormData>({});

  const wizard = WIZARDS.find((w) => w.id === selectedWizard);
  const step = wizard?.steps[currentStep];

  const handleNext = useCallback(() => {
    if (!wizard) return;
    if (currentStep < wizard.steps.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      const result = wizard.buildGraph(formData);
      onGenerate({ ...result, wizardId: wizard.id });
    }
  }, [wizard, currentStep, formData, onGenerate]);

  if (!selectedWizard) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Create Workflow from Wizard</h3>
          <button type="button" onClick={onClose} className="text-xs text-black/50 hover:text-black">&times;</button>
        </div>
        <div className="space-y-2">
          {WIZARDS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => { setSelectedWizard(w.id); setCurrentStep(0); setFormData({}); }}
              className="w-full text-left p-3 border border-black/10 hover:border-black/30 transition-colors"
            >
              <div className="text-sm font-medium">{w.name}</div>
              <div className="text-xs text-black/50 mt-0.5">{w.description}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (!wizard || !step) return null;

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold">{wizard.name}</h3>
          <div className="text-xs text-black/50">
            Step {currentStep + 1} of {wizard.steps.length}: {step.label}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-black/50 hover:text-black">&times;</button>
      </div>

      <div className="space-y-3">
        {step.fields.map((field) => {
          const value = formData[field.key] ?? field.defaultValue ?? "";
          return (
            <div key={field.key}>
              <label className="block text-xs font-medium text-black/60 mb-1">
                {field.label}{field.required ? " *" : ""}
              </label>
              {field.type === "select" && field.options ? (
                <select
                  value={String(value)}
                  onChange={(e) => setFormData((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-full px-2 py-1.5 text-xs border border-black/20"
                >
                  {field.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  value={String(value)}
                  onChange={(e) => setFormData((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  className="w-full px-2 py-1.5 text-xs border border-black/20 min-h-[80px]"
                />
              ) : (
                <input
                  type={field.type === "number" ? "number" : "text"}
                  value={String(value)}
                  onChange={(e) => setFormData((prev) => ({
                    ...prev,
                    [field.key]: field.type === "number" ? Number(e.target.value) : e.target.value,
                  }))}
                  placeholder={field.placeholder}
                  className="w-full px-2 py-1.5 text-xs border border-black/20"
                />
              )}
              {field.placeholder && <div className="text-[10px] text-black/40 mt-0.5">{field.placeholder}</div>}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between mt-4 pt-3 border-t border-black/10">
        <button
          type="button"
          onClick={() => currentStep > 0 ? setCurrentStep((s) => s - 1) : setSelectedWizard(null)}
          className="px-3 py-1 text-xs border border-black/20 hover:bg-black/5"
        >
          {currentStep === 0 ? "Back" : "Previous"}
        </button>
        <button
          type="button"
          onClick={handleNext}
          className="px-3 py-1 text-xs bg-black text-white hover:bg-black/80"
        >
          {currentStep < wizard.steps.length - 1 ? "Next" : "Generate Workflow"}
        </button>
      </div>
    </div>
  );
}

export { WIZARDS };
export type { WizardDefinition };
