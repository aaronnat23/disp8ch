"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";

type CompanyTemplate = {
  id: string;
  name: string;
  description: string;
  mission: string;
  tags: string[];
  roles: Array<{ key: string; roleTitle: string; presetIds?: string[] }>;
  goals: Array<{ key: string; name: string }>;
};

export type TemplatesPanelProps = {
  template: CompanyTemplate | null;
};

export function TemplatesPanel({ template }: TemplatesPanelProps) {
  if (!template) return null;

  return (
    <div className="rounded-md border border-border/80 bg-muted/20 p-3 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">{template.description}</div>
      <div className="mt-1">{template.mission}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {template.tags.map((tag) => (
          <Badge key={`${template.id}-${tag}`} variant="secondary" className="text-[10px]">
            {tag}
          </Badge>
        ))}
        <Badge variant="outline" className="text-[10px]">
          {template.roles.length} roles
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {template.goals.length} goals
        </Badge>
      </div>
    </div>
  );
}
