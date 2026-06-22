"use client";

import { useState, useEffect, useMemo } from "react";
import { Pencil, Trash, Plus, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatMessage } from "@/types/channel";

type EditableAppActionStep = {
  id: string;
  action: string;
  label: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
};

type EditableAppActionPlan = {
  version: number;
  confidence: number;
  userIntent: string;
  requiresConfirmation: boolean;
  assumptions: string[];
  steps: EditableAppActionStep[];
};

const APP_ACTIONS = [
  "create_agents",
  "create_organization",
  "run_council",
  "create_board_task",
  "assign_skill_to_agent",
  "attach_extension_to_agent",
  "create_workflow_from_template",
  "schedule_workflow",
  "connect_channel",
  "recommend_templates",
  "summarize_state",
  "link_board_task_to_agent",
] as const;

function readPendingAppActionPlan(message: ChatMessage): EditableAppActionPlan | null {
  const value = message.metadata?.pendingAppActionPlan as unknown;
  if (!value || typeof value !== "object") return null;
  const plan = value as Partial<EditableAppActionPlan>;
  if (!Array.isArray(plan.steps)) return null;
  return {
    version: Number(plan.version) || 1,
    confidence: Number(plan.confidence) || 0.7,
    userIntent: String(plan.userIntent || ""),
    requiresConfirmation: plan.requiresConfirmation !== false,
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
    steps: plan.steps.map((step, index) => {
      const record = step as Partial<EditableAppActionStep>;
      const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? record.params as Record<string, unknown>
        : {};
      return {
        id: String(record.id || `step-${index + 1}`),
        action: String(record.action || "summarize_state"),
        label: String(record.label || `Step ${index + 1}`),
        params,
        dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.map(String).filter(Boolean) : undefined,
      };
    }),
  };
}

export function PendingAppActionPlanEditor({
  message,
  loading,
  onConfirm,
  onCancel,
  onSaved,
}: {
  message: ChatMessage;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSaved: (messageId: string, plan: EditableAppActionPlan, summary: string) => void;
}) {
  const initialPlan = useMemo(() => readPendingAppActionPlan(message), [message]);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<EditableAppActionPlan | null>(initialPlan);
  const [paramsDrafts, setParamsDrafts] = useState<string[]>(() =>
    initialPlan?.steps.map((step) => JSON.stringify(step.params ?? {}, null, 2)) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initialPlan);
    setParamsDrafts(initialPlan?.steps.map((step) => JSON.stringify(step.params ?? {}, null, 2)) ?? []);
    setError(null);
  }, [initialPlan]);

  if (!draft) {
    return (
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onConfirm}>Confirm</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }

  const updateStep = (index: number, patch: Partial<EditableAppActionStep>) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        steps: current.steps.map((step, stepIndex) =>
          stepIndex === index ? { ...step, ...patch } : step,
        ),
      };
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const steps = draft.steps.map((step, index) => {
        let params: Record<string, unknown>;
        try {
          const parsed = JSON.parse(paramsDrafts[index] || "{}") as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("params must be a JSON object");
          }
          params = parsed as Record<string, unknown>;
        } catch (parseError) {
          throw new Error(`Step ${index + 1} params JSON is invalid: ${String(parseError)}`);
        }
        return {
          ...step,
          params,
          dependsOn: step.dependsOn?.filter(Boolean),
        };
      });
      const nextPlan = { ...draft, steps, requiresConfirmation: true };
      const response = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-pending-app-action-plan",
          sessionId: message.sessionId,
          plan: nextPlan,
        }),
      });
      const json = await response.json() as {
        success?: boolean;
        error?: string;
        data?: { plan?: EditableAppActionPlan; summary?: string };
      };
      if (!json.success || !json.data?.plan || !json.data.summary) {
        throw new Error(json.error || "Failed to save edited plan");
      }
      setDraft(json.data.plan);
      setParamsDrafts(json.data.plan.steps.map((step) => JSON.stringify(step.params ?? {}, null, 2)));
      onSaved(message.id, json.data.plan, json.data.summary);
      setExpanded(false);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border bg-background/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-foreground">Editable App Plan</div>
          <div className="text-[11px] text-muted-foreground">{draft.steps.length} step plan waits for confirmation.</div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setExpanded((current) => !current)} disabled={saving}>
            <Pencil className="mr-1 h-3.5 w-3.5" />
            {expanded ? "Hide Edit" : "Edit"}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={saving}>Confirm</Button>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium">
            Intent
            <Input
              className="mt-1"
              value={draft.userIntent}
              onChange={(event) => setDraft((current) => current ? { ...current, userIntent: event.target.value } : current)}
            />
          </label>
          <label className="block text-xs font-medium">
            Assumptions
            <textarea
              value={draft.assumptions.join("\n")}
              onChange={(event) => setDraft((current) => current ? {
                ...current,
                assumptions: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
              } : current)}
              className="mt-1 min-h-16 w-full resize-y rounded-md border bg-background px-3 py-2 text-xs"
            />
          </label>
          <div className="space-y-2">
            {draft.steps.map((step, index) => (
              <div key={`${step.id}-${index}`} className="rounded-md border p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold">Step {index + 1}</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive"
                    onClick={() => {
                      setDraft((current) => current ? {
                        ...current,
                        steps: current.steps.filter((_, stepIndex) => stepIndex !== index),
                      } : current);
                      setParamsDrafts((current) => current.filter((_, stepIndex) => stepIndex !== index));
                    }}
                    disabled={draft.steps.length <= 1}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-xs font-medium">
                    ID
                    <Input className="mt-1" value={step.id} onChange={(event) => updateStep(index, { id: event.target.value })} />
                  </label>
                  <label className="text-xs font-medium">
                    Action
                    <select
                      value={step.action}
                      onChange={(event) => updateStep(index, { action: event.target.value })}
                      className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-xs"
                    >
                      {APP_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                    </select>
                  </label>
                  <label className="md:col-span-2 text-xs font-medium">
                    Label
                    <Input className="mt-1" value={step.label} onChange={(event) => updateStep(index, { label: event.target.value })} />
                  </label>
                  <label className="md:col-span-2 text-xs font-medium">
                    Depends On
                    <Input
                      className="mt-1"
                      value={step.dependsOn?.join(", ") ?? ""}
                      onChange={(event) => updateStep(index, {
                        dependsOn: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                      })}
                      placeholder="agents, org"
                    />
                  </label>
                  <label className="md:col-span-2 text-xs font-medium">
                    Params JSON
                    <textarea
                      value={paramsDrafts[index] ?? "{}"}
                      onChange={(event) => setParamsDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                      className="mt-1 min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs"
                      spellCheck={false}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const id = `step-${draft.steps.length + 1}`;
                setDraft((current) => current ? {
                  ...current,
                  steps: [
                    ...current.steps,
                    { id, action: "summarize_state", label: "Review workspace state", params: {} },
                  ],
                } : current);
                setParamsDrafts((current) => [...current, "{}"]);
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add Step
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              Save Plan
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
