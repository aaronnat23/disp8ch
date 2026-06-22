"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type HierarchyOrganization = {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  memberCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type CompanyTemplate = {
  id: string;
  name: string;
  description: string;
  mission: string;
  tags: string[];
  roles: Array<{ key: string; roleTitle: string; presetIds?: string[] }>;
  goals: Array<{ key: string; name: string }>;
};

export type OrgEditorProps = {
  organizations: HierarchyOrganization[];
  activeOrganizationId: string;
  selectedOrganizationId: string;
  organizationName: string;
  organizationDescription: string;
  organizationMission: string;
  companyTemplates: CompanyTemplate[];
  selectedTemplateId: string;
  templateOrganizationName: string;
  applyingOrganization: boolean;
  savingOrganization: boolean;
  applyingCompanyTemplate: boolean;
  orgPackageBusy: boolean;
  orgImportInputRef: React.RefObject<HTMLInputElement | null>;
  onSelectOrganization: (id: string) => void;
  onOrganizationNameChange: (name: string) => void;
  onOrganizationDescriptionChange: (desc: string) => void;
  onOrganizationMissionChange: (mission: string) => void;
  onSelectTemplate: (id: string) => void;
  onTemplateOrganizationNameChange: (name: string) => void;
  onApplyOrganization: () => void;
  onSaveOrganization: () => void;
  onApplyCompanyTemplate: () => void;
  onExportPackage: () => void;
  onImportPackage: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export function OrgEditor({
  organizations,
  activeOrganizationId,
  selectedOrganizationId,
  organizationName,
  organizationDescription,
  organizationMission,
  companyTemplates,
  selectedTemplateId,
  templateOrganizationName,
  applyingOrganization,
  savingOrganization,
  applyingCompanyTemplate,
  orgPackageBusy,
  orgImportInputRef,
  onSelectOrganization,
  onOrganizationNameChange,
  onOrganizationDescriptionChange,
  onOrganizationMissionChange,
  onSelectTemplate,
  onTemplateOrganizationNameChange,
  onApplyOrganization,
  onSaveOrganization,
  onApplyCompanyTemplate,
  onExportPackage,
  onImportPackage,
}: OrgEditorProps) {
  const activeOrg = organizations.find((item) => item.id === activeOrganizationId);
  const selectedCompanyTemplate = companyTemplates.find(
    (t) => t.id === selectedTemplateId,
  );

  return (
    <div className="border-t border-border p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Active Organization</Label>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {activeOrg?.name || "No active organization"}
              </Badge>
              {activeOrg?.mission ? (
                <Badge variant="outline" className="max-w-full truncate">
                  {activeOrg.mission}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Switch Organization</Label>
            <div className="flex gap-2">
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={selectedOrganizationId}
                onChange={(event) => onSelectOrganization(event.target.value)}
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name} ({organization.memberCount} members)
                  </option>
                ))}
              </select>
              <Button
                onClick={() => onApplyOrganization()}
                disabled={applyingOrganization || !selectedOrganizationId}
              >
                {applyingOrganization ? "Switching..." : "Switch"}
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Save Current Organization Snapshot</Label>
          <Input
            placeholder="CEO Demo Org"
            value={organizationName}
            onChange={(event) => onOrganizationNameChange(event.target.value)}
          />
          <Input
            placeholder="Short description"
            value={organizationDescription}
            onChange={(event) =>
              onOrganizationDescriptionChange(event.target.value)
            }
          />
          <Textarea
            rows={2}
            placeholder="Mission / operating context"
            value={organizationMission}
            onChange={(event) =>
              onOrganizationMissionChange(event.target.value)
            }
          />
          <div className="flex justify-end">
            <Button
              onClick={() => onSaveOrganization()}
              disabled={savingOrganization || !organizationName.trim()}
            >
              {savingOrganization ? "Saving..." : "Save Snapshot"}
            </Button>
          </div>

          <div className="border-t border-dashed border-border pt-3">
            <div className="mb-2 flex items-center gap-2">
              <Label className="mb-0">Apply Company Template</Label>
              <Badge variant="outline" className="text-[10px]">
                Company-pack bootstrap
              </Badge>
            </div>
            <div className="space-y-2">
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={selectedTemplateId}
                onChange={(event) => onSelectTemplate(event.target.value)}
              >
                {companyTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <Input
                placeholder={
                  selectedCompanyTemplate
                    ? `${selectedCompanyTemplate.name} 2026-03-14`
                    : "Template organization name"
                }
                value={templateOrganizationName}
                onChange={(event) =>
                  onTemplateOrganizationNameChange(event.target.value)
                }
              />
              {selectedCompanyTemplate ? (
                <div className="rounded-md border border-border/80 bg-muted/20 p-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">
                    {selectedCompanyTemplate.description}
                  </div>
                  <div className="mt-1">{selectedCompanyTemplate.mission}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedCompanyTemplate.tags.map((tag) => (
                      <Badge
                        key={`${selectedCompanyTemplate.id}-${tag}`}
                        variant="secondary"
                        className="text-[10px]"
                      >
                        {tag}
                      </Badge>
                    ))}
                    <Badge variant="outline" className="text-[10px]">
                      {selectedCompanyTemplate.roles.length} roles
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {selectedCompanyTemplate.goals.length} goals
                    </Badge>
                  </div>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  onClick={() => onApplyCompanyTemplate()}
                  disabled={applyingCompanyTemplate || !selectedTemplateId}
                >
                  {applyingCompanyTemplate ? "Applying..." : "Apply Template"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
