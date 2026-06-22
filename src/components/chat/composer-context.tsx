"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Badge } from "lucide-react";

type ComposerContextProps = {
  agents: Array<{ id: string; name: string; workspacePath: string; modelRef: string | null; isDefault?: boolean; isActive?: boolean }>;
  models: Array<{ id: string; provider: string; modelId: string; name: string }>;
  sessionAgentId: string | null;
  sessionModelRef: string | null;
  sessionToolMode: "default" | "restricted" | "full";
  sessionWorkspacePath: string | null;
  activeAgent: { id: string; name: string; workspacePath: string } | null;
  activeChannelLabel: string;
  agentModelLabel: string;
  agentCapabilityLabel: string;
  liveMeter: {
    contextPercent: number | null;
    contextWindow?: number | null;
    historyTokens?: number;
    draftTokens?: number;
    estimatedOutputTokens?: number;
    estimatedCost?: string;
  };
  onUpdateSettings: (patch: {
    agentId?: string | null;
    modelRef?: string | null;
    toolMode?: "default" | "restricted" | "full";
    workspacePath?: string | null;
  }) => void;
  trustedWorkspaces: Array<{ path: string; label: string; source: string }>;
  defaultAgent: { id: string; name: string } | null;
};

const RingGauge = ({ pct }: { pct: number | null }) => {
  const radius = 12;
  const strokeWidth = 3;
  const normalized = Math.min(100, Math.max(0, pct ?? 0));
  const color = normalized > 75 ? "#ef4444" : normalized > 50 ? "#f59e0b" : "#22c55e";
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (normalized / 100) * circumference;

  return (
    <svg width="28" height="28" viewBox="0 0 28 28" className="shrink-0">
      <circle cx="14" cy="14" r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted-foreground/30" />
      <circle
        cx="14" cy="14" r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" transform="rotate(-90 14 14)"
      />
      <text x="14" y="16" textAnchor="middle" className="fill-foreground text-[8px] font-medium">{Math.round(normalized)}</text>
    </svg>
  );
};

const ChipDropdown = ({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  placeholder: string;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-0.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
      >
        <span className="max-w-[100px] truncate">{selected?.label || placeholder}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border bg-popover p-1 shadow-md">
          <button
            type="button"
            className="block w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => { onChange(null); setOpen(false); }}
          >
            {placeholder}
          </button>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="block w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => { onChange(opt.value || null); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ToolModeOptions = [
  { value: "default", label: "Default" },
  { value: "restricted", label: "Restricted" },
  { value: "full", label: "Full" },
];

export function ComposerContextStrip({
  agents,
  models,
  sessionAgentId,
  sessionModelRef,
  sessionToolMode,
  sessionWorkspacePath,
  activeAgent,
  activeChannelLabel,
  agentModelLabel,
  agentCapabilityLabel,
  liveMeter,
  onUpdateSettings,
  trustedWorkspaces,
  defaultAgent,
}: ComposerContextProps) {
  const agentOptions = [
    { value: "", label: `Default: ${defaultAgent?.name || "main"}` },
    ...agents
      .filter((a) => a.isActive !== false)
      .map((a) => ({ value: a.id, label: a.name })),
  ];

  const modelOptions = [
    { value: "", label: "Inherit active model" },
    ...models.map((m) => ({
      value: `${m.provider}:${m.modelId}`,
      label: `${m.name || m.modelId} [${m.provider}]`,
    })),
  ];

  const workspaceOptions = [
    { value: "", label: "Default workspace" },
    ...trustedWorkspaces.map((w) => ({
      value: w.path,
      label: `${w.label} [${w.source}]`,
    })),
  ];

  const currentAgent = agents.find((a) => a.id === sessionAgentId) ?? activeAgent;
  const workspaceValue = sessionWorkspacePath ?? activeAgent?.workspacePath ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</span>
        <ChipDropdown
          value={sessionAgentId}
          options={agentOptions}
          onChange={(value) => {
            const agent = agents.find((entry) => entry.id === value) ?? null;
            onUpdateSettings({ agentId: value, workspacePath: agent?.workspacePath ?? null });
          }}
          placeholder={`Default: ${defaultAgent?.name || "main"}`}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Model</span>
        <ChipDropdown
          value={sessionModelRef}
          options={modelOptions}
          onChange={(value) => onUpdateSettings({ modelRef: value })}
          placeholder="Inherit active model"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Tool Mode</span>
        <ChipDropdown
          value={sessionToolMode}
          options={ToolModeOptions}
          onChange={(value) => onUpdateSettings({ toolMode: value as "default" | "restricted" | "full" })}
          placeholder="Default"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Workspace</span>
        <ChipDropdown
          value={workspaceValue}
          options={workspaceOptions}
          onChange={(value) => onUpdateSettings({ workspacePath: value })}
          placeholder="Default workspace"
        />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="rounded-md border bg-background px-2 py-1 text-xs font-medium text-foreground">
          {activeChannelLabel}
        </span>
        <span className="text-xs text-muted-foreground hidden lg:inline">Model: {agentModelLabel}</span>
        <div className="hidden items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground md:flex">
          <span>
            ctx {liveMeter.contextPercent === null ? "n/a" : `${liveMeter.contextPercent}%`}
          </span>
          <span className="text-muted-foreground/50">|</span>
          <span>
            {Math.max(0, Math.round((liveMeter.historyTokens ?? 0) + (liveMeter.draftTokens ?? 0))).toLocaleString()} tok
          </span>
          <span className="text-muted-foreground/50">|</span>
          <span>{liveMeter.estimatedCost ?? "$0"}</span>
        </div>
        <RingGauge pct={liveMeter.contextPercent} />
      </div>
    </div>
  );
}
