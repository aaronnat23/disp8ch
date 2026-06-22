"use client";

import { type NodeProps } from "@xyflow/react";
import { Terminal } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function ToolNode({ data, type, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const nodeType = String(type || "");
  const action = String(nodeData.action || "");
  const operation = String(nodeData.operation || "");
  const path = (nodeData.path as string) || ".";
  const boardId = (nodeData.boardId as string) || "main-board";
  const originalType = String(nodeData.originalType || "");
  const warning = String(nodeData.warning || "");

  const actionLabel = (() => {
    if (nodeType === "placeholder") {
      return originalType ? `Unsupported import: ${originalType}` : "Unsupported imported node";
    }
    if (nodeType === "system-command") {
      if (action === "list-files") return `List files: ${path}`;
      if (action === "command") return "Run imported shell command";
      return "Collect PC specs";
    }
    if (nodeType === "board-task") return `${action || "list"} tasks on ${boardId}`;
    if (nodeType === "document-tool") return `${action || "list"} documents`;
    if (nodeType === "workflow-template") return `${action || "list-templates"} workflow templates`;
    if (nodeType === "scheduler-job") return `${action || "list"} scheduled workflows`;
    if (nodeType === "google-sheets") return `${action || "read"} Google Sheets range`;
    if (nodeType === "notion") return `${action || "query-database"} Notion resource`;
    if (nodeType === "airtable") return `${action || "list-records"} Airtable records`;
    if (nodeType === "date-time") return `${operation || "now"} date/time`;
    if (nodeType === "channel-status") return "Inspect connected channels";
    if (nodeType === "council") return "Run leadership council decision";
    return "Workflow utility node";
  })();

  return (
    <BaseNode
      accent="cyan"
      selected={selected}
      icon={<Terminal className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Workflow Tool"}
      minWidth={220}
     {...readNodeOverlayProps(data)}>
      <div>{actionLabel}</div>
      {warning ? <div className="mt-1 text-amber-500">{warning}</div> : null}
    </BaseNode>
  );
}
