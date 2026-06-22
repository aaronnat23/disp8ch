"use client";

import React from "react";

export type GettingStartedProps = {
  onDismiss: () => void;
  mode?: "new" | "continue";
  globalModelLabel?: string | null;
};

export function GettingStarted({ onDismiss, mode = "new", globalModelLabel }: GettingStartedProps) {
  const continuing = mode === "continue";
  const modelCopy = globalModelLabel
    ? `Agents can use the active global model fallback (${globalModelLabel}), or you can set a per-agent model from Agents.`
    : "Set one active global model from onboarding/settings, or set a per-agent model from Agents.";

  return (
    <div className="mb-5 border border-terminal-red/40 bg-terminal-red/5 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-terminal-red">
          {continuing ? "GETTING STARTED - FINISH HIERARCHY SETUP" : "GETTING STARTED - HIERARCHY"}
        </div>
        <button
          type="button"
          className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-terminal-red"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
      <p className="text-sm text-muted-foreground max-w-2xl">
        {continuing ? (
          <>
            Finish this <strong>organization</strong> by confirming models, adding clear goals, then asking the org to execute from WebChat or Goal Focus.
          </>
        ) : (
          <>
            Build an <strong>organization</strong>, add <strong>agents</strong> with clear roles, define <strong>goals</strong>, then ask the org to execute from WebChat or assign work from Goal Focus.
          </>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-3 text-[11px] font-mono">
        <div className="border border-border p-3 space-y-1">
          <div className="text-terminal-red uppercase tracking-wide">
            {continuing ? "Step 1 - Confirm Models" : "Step 1 - Create an Org"}
          </div>
          <div className="text-muted-foreground">
            {continuing ? (
              modelCopy
            ) : (
              <>Use <strong>ORGANIZATIONS</strong> to create one from scratch or apply a company template with agents, roles, and starter goals.</>
            )}
          </div>
        </div>
        <div className="border border-border p-3 space-y-1">
          <div className="text-terminal-red uppercase tracking-wide">Step 2 - Add Goals</div>
          <div className="text-muted-foreground">
            Use <strong>GOALS</strong> to capture the outcomes this org owns, from vision down to key results.
          </div>
        </div>
        <div className="border border-border p-3 space-y-1">
          <div className="text-terminal-red uppercase tracking-wide">Step 3 - Ask the Org</div>
          <div className="text-muted-foreground">
            Select a goal, then use <strong>Ask WebChat</strong>, <strong>Ask Agents</strong>, or <strong>Assign to All Agents</strong> to turn the org into execution.
          </div>
        </div>
      </div>
    </div>
  );
}
