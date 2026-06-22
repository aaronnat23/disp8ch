"use client";

import { useExecutionStore } from "@/stores/execution-store";
import { useWorkflowStore } from "@/stores/workflow-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useState, useEffect, useRef } from "react";

export function ExecutionLog() {
  const { logEntries, clearLog, streamingTokens } = useExecutionStore();
  const { nodes } = useWorkflowStore();
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeStreamNodeIds = Object.keys(streamingTokens);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logEntries, streamingTokens]);

  return (
    <div className="border-t bg-card">
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1 text-sm font-medium"
        >
          {collapsed ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          Execution Log ({logEntries.length + activeStreamNodeIds.length})
        </button>
        {(logEntries.length > 0 || activeStreamNodeIds.length > 0) && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={clearLog}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      {!collapsed && (
        <ScrollArea className="h-[180px]" ref={scrollRef as React.RefObject<HTMLDivElement>}>
          <div className="p-2 font-mono text-xs space-y-0.5">
            {logEntries.length === 0 && activeStreamNodeIds.length === 0 ? (
              <div className="text-muted-foreground py-4 text-center">
                No execution logs yet. Click Run to execute the workflow.
              </div>
            ) : (
              <>
                {logEntries.map((entry, i) => (
                  <div
                    key={i}
                    className={`flex gap-2 px-1 py-0.5 rounded ${
                      entry.type === "error"
                        ? "text-red-400"
                        : entry.type === "success"
                        ? "text-green-400"
                        : entry.type === "streaming"
                        ? "text-blue-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    <span className="text-muted-foreground shrink-0">
                      [{new Date(entry.timestamp).toLocaleTimeString()}]
                    </span>
                    <span className="font-semibold shrink-0">{entry.nodeName}</span>
                    <span>{entry.message}</span>
                  </div>
                ))}
                {activeStreamNodeIds.map((nodeId) => {
                  const node = nodes.find((n) => n.id === nodeId);
                  const nodeName = (node?.data?.label as string) || nodeId;
                  const tokens = streamingTokens[nodeId] || "";
                  return (
                    <div key={`stream-${nodeId}`} className="px-1 py-0.5 rounded text-blue-400">
                      <div className="flex gap-2">
                        <span className="text-muted-foreground shrink-0">
                          [{new Date().toLocaleTimeString()}]
                        </span>
                        <span className="font-semibold shrink-0">{nodeName}</span>
                        <span className="text-blue-300 text-xs">streaming…</span>
                      </div>
                      <div className="mt-0.5 pl-4 text-blue-200 whitespace-pre-wrap break-words">
                        {tokens}
                        <span className="animate-pulse">▋</span>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
