"use client";

import type { ReactNode } from "react";
import {
  Accessibility,
  Eye,
  LayoutTemplate,
  MonitorSmartphone,
  Route,
  Save,
  Sparkles,
  Users,
} from "lucide-react";
import type { DesignProjectPlan } from "@/components/design-studio/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type EditablePlan = Omit<DesignProjectPlan, "updatedAt">;

function listValue(items: string[]): string {
  return items.join("\n");
}

function parseList(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function PlanField({
  icon,
  label,
  hint,
  children,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border-t border-border py-5 first:border-t-0">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-terminal-red/40 text-terminal-red">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold uppercase text-foreground">{label}</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function DesignPlanPanel({
  projectName,
  plan,
  saving,
  hasArtifact,
  onChange,
  onSave,
  onPreview,
  onAskAssistant,
}: {
  projectName: string;
  plan: EditablePlan;
  saving: boolean;
  hasArtifact: boolean;
  onChange: (plan: EditablePlan) => void;
  onSave: () => void;
  onPreview: () => void;
  onAskAssistant: () => void;
}) {
  const set = <K extends keyof EditablePlan>(key: K, value: EditablePlan[K]) => {
    onChange({ ...plan, [key]: value });
  };

  const filledSections = [
    plan.productGoal,
    plan.primaryUsers,
    plan.primaryFlow.length,
    plan.screens.length,
    plan.states.length,
    plan.visualDirection,
    plan.responsiveNotes,
    plan.accessibilityNotes,
  ].filter(Boolean).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-testid="design-plan-panel">
      <header className="shrink-0 border-b border-border bg-card/30 px-7 py-6">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0 max-w-3xl">
            <div className="data-label text-terminal-red">UI/UX plan</div>
            <h2 className="mt-2 truncate font-display text-2xl font-semibold text-foreground">{projectName}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Define the user, information architecture, states, and experience contract before polishing pixels.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={onAskAssistant}>
              <Sparkles className="h-4 w-4" />
              Ask assistant
            </Button>
            {hasArtifact ? (
              <Button size="sm" variant="outline" onClick={onPreview}>
                <Eye className="h-4 w-4" />
                Preview
              </Button>
            ) : null}
            <Button size="sm" onClick={onSave} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "Saving" : "Save plan"}
            </Button>
          </div>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-3 border-b border-border bg-card/20">
        <div className="border-r border-border px-6 py-3">
          <div className="data-label">Coverage</div>
          <div className="mt-1 font-display text-xl font-semibold text-foreground">{filledSections}/8</div>
        </div>
        <div className="border-r border-border px-6 py-3">
          <div className="data-label">Screens</div>
          <div className="mt-1 font-display text-xl font-semibold text-foreground">{plan.screens.length}</div>
        </div>
        <div className="px-6 py-3">
          <div className="data-label">Critical states</div>
          <div className="mt-1 font-display text-xl font-semibold text-foreground">{plan.states.length}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7">
        <div className="grid min-h-full gap-x-8 lg:grid-cols-2">
          <div className="min-w-0 lg:border-r lg:border-border lg:pr-8">
            <PlanField icon={<LayoutTemplate className="h-4 w-4" />} label="Product goal" hint="The outcome this interface must help someone achieve.">
              <Textarea
                aria-label="Product goal"
                value={plan.productGoal}
                onChange={(event) => set("productGoal", event.target.value)}
                placeholder="Turn a meeting decision into clear, owned next steps."
                className="min-h-[88px] resize-y"
              />
            </PlanField>
            <PlanField icon={<Users className="h-4 w-4" />} label="Primary users" hint="Who uses it, in what context, and what pressure they are under.">
              <Input
                aria-label="Primary users"
                value={plan.primaryUsers}
                onChange={(event) => set("primaryUsers", event.target.value)}
                placeholder="Product leads leaving a fast-moving launch review"
              />
            </PlanField>
            <PlanField icon={<Route className="h-4 w-4" />} label="Primary flow" hint="One action per line, ordered from entry to successful outcome.">
              <Textarea
                aria-label="Primary flow"
                value={listValue(plan.primaryFlow)}
                onChange={(event) => set("primaryFlow", parseList(event.target.value))}
                placeholder={"Open meeting brief\nReview cited decision\nAssign owners\nShare approved outcome"}
                className="min-h-[136px] resize-y font-mono text-xs"
              />
            </PlanField>
            <PlanField icon={<MonitorSmartphone className="h-4 w-4" />} label="Screens and surfaces" hint="One screen, modal, panel, or breakpoint-specific surface per line.">
              <Textarea
                aria-label="Screens and surfaces"
                value={listValue(plan.screens)}
                onChange={(event) => set("screens", parseList(event.target.value))}
                placeholder={"Meeting overview\nDecision detail\nOwner handoff\nMobile review"}
                className="min-h-[120px] resize-y font-mono text-xs"
              />
            </PlanField>
          </div>

          <div className="min-w-0">
            <PlanField icon={<Eye className="h-4 w-4" />} label="Critical states" hint="Loading, empty, error, permission, success, and risky-action states to design explicitly.">
              <Textarea
                aria-label="Critical states"
                value={listValue(plan.states)}
                onChange={(event) => set("states", parseList(event.target.value))}
                placeholder={"Live transcription\nMissing owner\nConflicting decision\nReady to share"}
                className="min-h-[120px] resize-y font-mono text-xs"
              />
            </PlanField>
            <PlanField icon={<Sparkles className="h-4 w-4" />} label="Visual direction" hint="Brand character, palette, typography, density, and motion intent.">
              <Textarea
                aria-label="Visual direction"
                value={plan.visualDirection}
                onChange={(event) => set("visualDirection", event.target.value)}
                placeholder="Bright editorial workspace with cobalt actions, mint evidence states, and calm spatial motion."
                className="min-h-[96px] resize-y"
              />
            </PlanField>
            <PlanField icon={<MonitorSmartphone className="h-4 w-4" />} label="Responsive contract" hint="How hierarchy, density, and core actions adapt across widths.">
              <Textarea
                aria-label="Responsive contract"
                value={plan.responsiveNotes}
                onChange={(event) => set("responsiveNotes", event.target.value)}
                placeholder="Preserve the decision and next action first; stack evidence below at tablet widths."
                className="min-h-[96px] resize-y"
              />
            </PlanField>
            <PlanField icon={<Accessibility className="h-4 w-4" />} label="Accessibility contract" hint="Keyboard, focus, motion, contrast, labels, and assistive technology requirements.">
              <Textarea
                aria-label="Accessibility contract"
                value={plan.accessibilityNotes}
                onChange={(event) => set("accessibilityNotes", event.target.value)}
                placeholder="Keyboard-complete navigation, visible focus, reduced motion, semantic headings, and WCAG AA contrast."
                className="min-h-[96px] resize-y"
              />
            </PlanField>
          </div>
        </div>
      </div>
    </div>
  );
}
