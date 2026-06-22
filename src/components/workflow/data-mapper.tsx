"use client";

import React, { useMemo, useState } from "react";
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type { NodeResult } from "@/types/execution";
import { buildFieldPickerItems, type UpstreamFieldRef } from "@/lib/engine/workflow-data-paths";

type DataMapperProps = {
  currentNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  nodeResults?: Record<string, NodeResult>;
  onInsertTemplate?: (templatePath: string) => void;
  className?: string;
};

export function DataMapper({ currentNodeId, nodes, edges, nodeResults, onInsertTemplate, className }: DataMapperProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState("");

  const fieldItems = useMemo(
    () => buildFieldPickerItems(currentNodeId, nodes, edges, nodeResults),
    [currentNodeId, nodes, edges, nodeResults],
  );

  const filtered = useMemo(
    () => (searchTerm
      ? fieldItems.filter((f) =>
          f.display.toLowerCase().includes(searchTerm.toLowerCase()) ||
          f.templatePath.toLowerCase().includes(searchTerm.toLowerCase()))
      : fieldItems),
    [fieldItems, searchTerm],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, UpstreamFieldRef[]>();
    for (const item of filtered) {
      const key = item.nodeLabel;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return groups;
  }, [filtered]);

  if (fieldItems.length === 0) return null;

  return (
    <div className={`border border-black/10 p-3 ${className ?? ""}`}>
      <div className="text-xs font-medium text-black/50 mb-2 uppercase tracking-wider">
        Insert Data
      </div>
      <input
        type="text"
        placeholder="Search upstream fields..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="w-full px-2 py-1 text-xs border border-black/10 mb-2"
      />
      <div className="max-h-64 overflow-y-auto space-y-1">
        {Array.from(grouped.entries()).map(([nodeLabel, items]) => {
          const isExpanded = expanded[nodeLabel] !== false;
          const firstItem = items[0];
          const nodeResult = nodeResults?.[firstItem?.nodeId ?? ""];

          return (
            <div key={nodeLabel} className="border border-black/5">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [nodeLabel]: !prev[nodeLabel] }))}
                className="w-full text-left px-2 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 flex items-center justify-between"
              >
                <span className="truncate">{nodeLabel}</span>
                <span className="text-black/40 ml-1">{isExpanded ? "▾" : "▸"}</span>
              </button>
              {isExpanded && (
                <div className="divide-y divide-black/5">
                  {items.map((item) => {
                    const hasSample = nodeResult?.output?.[item.fieldPath] !== undefined;
                    const sampleValue = hasSample ? String(nodeResult.output[item.fieldPath]).slice(0, 60) : null;

                    return (
                      <button
                        key={item.templatePath}
                        type="button"
                        onClick={() => onInsertTemplate?.(item.templatePath)}
                        className="w-full text-left px-3 py-1.5 hover:bg-black/5 transition-colors group"
                      >
                        <div className="text-xs flex items-center justify-between">
                          <span className="text-black/80 group-hover:text-black">
                            {item.fieldLabel}
                          </span>
                          <span className="text-[10px] text-black/40 font-mono group-hover:text-black/70 ml-2 truncate max-w-[140px]">
                            {item.templatePath}
                          </span>
                        </div>
                        {sampleValue !== null && (
                          <div className="text-[10px] text-black/60 font-mono truncate mt-0.5 border-l-2 border-green-500/30 pl-1.5">
                            {sampleValue}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
