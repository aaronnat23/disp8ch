"use client";

import { useState } from "react";
import { ChevronDown, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface AgentRef {
  id: string;
  name: string;
  role?: string;
  isActive: boolean;
}

export function ReportsToPicker({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: AgentRef[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const selectedAgent = agents.find((a) => a.id === value);
  const isStale = !!value && !selectedAgent;
  const isTerminated = selectedAgent && !selectedAgent.isActive;
  const activeAgents = agents.filter((a) => a.isActive && a.id !== value);
  const terminatedAgents = agents.filter((a) => !a.isActive && a.id !== value);

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className={`h-8 w-full justify-between text-xs ${
          isStale
            ? "border-destructive/50 text-destructive"
            : isTerminated
              ? "border-amber-500/50"
              : ""
        }`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
      >
        {isStale ? (
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 text-destructive" />
            Unknown manager (stale ID)
          </span>
        ) : isTerminated ? (
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            {selectedAgent.name} (terminated)
          </span>
        ) : selectedAgent ? (
          <span>
            {selectedAgent.name}{" "}
            {selectedAgent.role ? (
              <span className="text-muted-foreground">· {selectedAgent.role}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">No manager</span>
        )}
        <ChevronDown className="ml-2 h-3 w-3" />
      </Button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded-md border bg-popover p-1 shadow-md">
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              No manager
            </button>
            {isStale ? (
              <div className="px-2 py-1 text-[10px] text-muted-foreground">
                Saved manager ID is missing from this org.
              </div>
            ) : null}
            {activeAgents.map((a) => (
              <button
                key={a.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                onClick={() => {
                  onChange(a.id);
                  setOpen(false);
                }}
              >
                <span>{a.name}</span>
                {a.role ? (
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    {a.role}
                  </Badge>
                ) : null}
              </button>
            ))}
            {terminatedAgents.length > 0 ? (
              <div className="mt-1 border-t pt-1">
                <div className="px-2 py-0.5 text-[10px] text-muted-foreground">
                  Terminated
                </div>
                {terminatedAgents.map((a) => (
                  <button
                    key={a.id}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    onClick={() => {
                      onChange(a.id);
                      setOpen(false);
                    }}
                  >
                    <span>{a.name}</span>
                    <Badge
                      variant="outline"
                      className="ml-auto text-[10px] border-amber-500/30 text-amber-500"
                    >
                      terminated
                    </Badge>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
