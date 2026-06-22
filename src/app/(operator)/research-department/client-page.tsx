"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SetupWizard, type CreatePayload } from "@/components/research-department/setup-wizard";
import { DepartmentCard, type DepartmentSummary } from "@/components/research-department/department-card";
import { RunSummary, type TestRunResult } from "@/components/research-department/run-summary";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

type ResearchDepartmentPanelProps = {
  embedded?: boolean;
  onDepartmentChange?: () => void;
};

export function ResearchDepartmentPanel({
  embedded = false,
  onDepartmentChange,
}: ResearchDepartmentPanelProps) {
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<TestRunResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/research-departments");
      const json = (await res.json()) as ApiResponse<DepartmentSummary[]>;
      if (json.success && json.data) setDepartments(json.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(
    async (payload: CreatePayload) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/research-departments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiResponse<unknown>;
        if (!json.success) {
          setError(json.error || "Failed to create department");
        } else {
          setShowWizard(false);
          await load();
          onDepartmentChange?.();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, onDepartmentChange],
  );

  const handleTestRun = useCallback(async (id: string) => {
    setBusy(true);
    setRunResult(null);
    try {
      const res = await fetch(`/api/research-departments/${id}/test-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: true }),
      });
      const json = (await res.json()) as ApiResponse<TestRunResult>;
      if (json.success && json.data) setRunResult(json.data);
      else setError(json.error || "Test run failed");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleTogglePause = useCallback(
    async (id: string, paused: boolean) => {
      setBusy(true);
      try {
        await fetch(`/api/research-departments/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused }),
        });
        await load();
        onDepartmentChange?.();
      } finally {
        setBusy(false);
      }
    },
    [load, onDepartmentChange],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this department? Agents and workflows are removed; vault files are kept on disk.")) return;
      setBusy(true);
      try {
        await fetch(`/api/research-departments/${id}`, { method: "DELETE" });
        await load();
        onDepartmentChange?.();
      } finally {
        setBusy(false);
      }
    },
    [load, onDepartmentChange],
  );

  return (
    <div className={embedded ? "space-y-4" : "space-y-4 p-4"} data-perf-ready="research-department">
      <div className="flex items-center justify-between">
        <div>
          {!embedded ? <h1 className="text-lg font-semibold text-terminal-text">Research Teams</h1> : null}
          <p className="text-xs text-terminal-muted">
            Scout → inbox → Analyst → wiki → Briefer → morning brief. Real agents, workflows, schedules, and a local
            markdown vault — all inspectable.
          </p>
        </div>
        {!showWizard && (
          <Button size="sm" onClick={() => { setShowWizard(true); setRunResult(null); }}>
            Create Research Team
          </Button>
        )}
      </div>

      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {showWizard && (
        <SetupWizard busy={busy} onCancel={() => setShowWizard(false)} onCreate={handleCreate} />
      )}

      {runResult && <RunSummary result={runResult} />}

      {loading ? (
        <p className="text-xs text-terminal-muted">Loading…</p>
      ) : departments.length === 0 && !showWizard ? (
        <p className="text-xs text-terminal-muted">No research teams yet. Create one to add its agents, workflows, schedules, and local vault.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {departments.map((d) => (
            <DepartmentCard
              key={d.id}
              dept={d}
              busy={busy}
              onTestRun={handleTestRun}
              onTogglePause={handleTogglePause}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ResearchDepartmentClientPage() {
  return <ResearchDepartmentPanel />;
}
