"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const LINKED_SOURCE_LABELS: Record<string, string> = {
  upload: "Uploaded Source",
  scrape: "Scraped Source",
  integration: "Connected Source",
  document: "Document",
  "data-source": "Data Source",
  "board-task": "Board Task",
  "cron-generated": "Cron Generated",
};

function formatSourceSize(size: number | null): string {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type LinkedDocumentSummary = {
  id: string;
  sourceType: string;
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  excerpt: string;
  createdAt: string;
  updatedAt?: string;
};

type GoalSourcePackItem = {
  key: string;
  sourceType: string | null;
  sourceRef: string | null;
  label: string;
  taskCount: number;
  workflowCount: number;
  document: LinkedDocumentSummary | null;
};

export type SourcePacksProps = {
  scopedGoalSourcePack: GoalSourcePackItem[];
  scopedGoalLinkedSources: string[];
  goalId: string;
  goalName: string;
  organizationId: string | null;
};

export function SourcePacks({ scopedGoalSourcePack, scopedGoalLinkedSources, goalId, goalName, organizationId }: SourcePacksProps) {
  const router = useRouter();

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal Source Pack</div>
        <Badge variant="outline" className="text-[10px]">
          {scopedGoalSourcePack.length} linked
        </Badge>
      </div>
      {scopedGoalSourcePack.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">
          No data sources or source refs attached yet.
        </div>
      ) : (
        <div data-testid="hierarchy-source-pack" className="mt-2 space-y-2">
          {scopedGoalSourcePack.slice(0, 4).map((source) => {
            const linkedDocument = source.document;
            return (
              <div
                key={`${goalId}-source-card-${source.key}`}
                data-testid="hierarchy-source-card"
                className="rounded-md border border-border/70 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {linkedDocument?.name || source.label}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {LINKED_SOURCE_LABELS[String(source.sourceType || "").toLowerCase()] || source.sourceType || "Source"}
                      </Badge>
                      {source.taskCount > 0 ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {source.taskCount} task{source.taskCount === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                      {source.workflowCount > 0 ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {source.workflowCount} workflow{source.workflowCount === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                      {linkedDocument ? (
                        <Badge variant="outline" className="text-[10px]">
                          {formatSourceSize(linkedDocument.sizeBytes)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {linkedDocument ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => router.push(`/documents?documentId=${encodeURIComponent(linkedDocument.id)}`)}
                    >
                      Open Source
                    </Button>
                  ) : null}
                </div>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {linkedDocument?.sourceUrl ? (
                    <div className="truncate">{linkedDocument.sourceUrl}</div>
                  ) : source.sourceRef ? (
                    <div className="font-mono">{source.sourceRef}</div>
                  ) : null}
                  {linkedDocument?.excerpt ? (
                    <p className="line-clamp-3 text-xs">{linkedDocument.excerpt}</p>
                  ) : (
                    <p className="text-xs">
                      This source is linked by reference only. Open the downstream tabs to inspect the bound work.
                    </p>
                  )}
                </div>
                {linkedDocument ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => router.push(`/boards?documentId=${encodeURIComponent(linkedDocument.id)}`)}
                    >
                      Boards
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px]"
                      onClick={() =>
                        router.push(
                          `/workflows?template=document-intelligence&documentId=${encodeURIComponent(linkedDocument.id)}`,
                        )
                      }
                    >
                      Workflows
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px]"
                      onClick={() =>
                        {
                          const params = new URLSearchParams({
                            documentId: linkedDocument.id,
                            topic: `What should the team decide after reviewing ${linkedDocument.name} for goal ${goalName}?`,
                            goal: goalId,
                          });
                          if (organizationId) params.set("org", organizationId);
                          router.push(`/council?${params.toString()}`);
                        }
                      }
                    >
                      Council
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            {scopedGoalLinkedSources.map((source) => (
              <Badge key={`${goalId}-source-${source}`} variant="outline" className="text-[10px]">
                {source}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
