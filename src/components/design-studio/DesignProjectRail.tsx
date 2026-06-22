"use client";

import { FileCode2, FolderPlus, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DesignArtifactSummary, DesignProjectSummary } from "@/components/design-studio/types";

export function DesignProjectRail({
  projects,
  artifacts,
  activeProjectId,
  activeArtifactId,
  onCreateProject,
  onSelectProject,
  onSelectArtifact,
}: {
  projects: DesignProjectSummary[];
  artifacts: DesignArtifactSummary[];
  activeProjectId: string | null;
  activeArtifactId: string | null;
  onCreateProject: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectArtifact: (artifactId: string) => void;
}) {
  return (
    <aside className="flex h-full w-[286px] shrink-0 flex-col border-r border-border bg-card/60">
      <div className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-terminal-red" />
          <span className="text-xs font-semibold uppercase tracking-wider">Designs</span>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCreateProject} title="New project">
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Projects</div>
        <div className="space-y-px px-2">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onSelectProject(project.id)}
              className={cn(
                "flex w-full items-center gap-2 border-l-2 px-2 py-2 text-left text-xs transition-colors",
                activeProjectId === project.id
                  ? "border-terminal-red bg-terminal-red/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{project.artifactCount}</span>
            </button>
          ))}
          {projects.length === 0 ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">No projects yet.</div>
          ) : null}
        </div>

        <div className="mt-3 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Artifacts</div>
        <div className="space-y-px px-2 pb-4">
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              onClick={() => onSelectArtifact(artifact.id)}
              className={cn(
                "flex w-full items-center gap-2 border-l-2 px-2 py-2 text-left text-xs transition-colors",
                activeArtifactId === artifact.id
                  ? "border-terminal-red bg-terminal-red/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
              <span className="font-mono text-[10px] text-muted-foreground">v{artifact.currentVersionNumber ?? 0}</span>
            </button>
          ))}
          {activeProjectId && artifacts.length === 0 ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">No artifacts in this project.</div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
