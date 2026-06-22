"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type HierarchyGoal = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  organizationName: string | null;
  parentGoalId: string | null;
  parentGoalName: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  status: "planned" | "active" | "blocked" | "done";
  level: "vision" | "mission" | "objective" | "key_result" | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type BoardTask = {
  id: string;
  title: string;
  status: "inbox" | "in_progress" | "review" | "done" | "blocked";
  priority?: "low" | "medium" | "high";
  assignedAgentName?: string | null;
  goalId?: string | null;
  organizationId?: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  active: "border-green-500/50 text-green-400",
  blocked: "border-terminal-red text-terminal-red",
  done: "border-muted text-muted-foreground",
  planned: "border-yellow-500/50 text-yellow-400",
};

const TASK_STATUS_COLORS: Record<string, string> = {
  done: "bg-green-500/10 text-green-400",
  blocked: "bg-terminal-red/10 text-terminal-red",
  in_progress: "bg-blue-500/10 text-blue-400",
  review: "bg-yellow-500/10 text-yellow-400",
  inbox: "bg-muted text-muted-foreground",
};

export default function GoalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [goal, setGoal] = useState<HierarchyGoal | null>(null);
  const [allGoals, setAllGoals] = useState<HierarchyGoal[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  // Inline edit state
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [descValue, setDescValue] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Deliverables edit state
  const [newDeliverable, setNewDeliverable] = useState("");
  const [savingDeliverable, setSavingDeliverable] = useState(false);

  const loadGoal = async () => {
    const [goalsRes, tasksRes] = await Promise.all([
      fetch("/api/hierarchy/goals"),
      fetch(`/api/boards/tasks?goalId=${id}`),
    ]);
    const goalsJson = await goalsRes.json() as { success: boolean; data: HierarchyGoal[] };
    const tasksJson = await tasksRes.json() as { success?: boolean; data?: BoardTask[] };

    if (goalsJson.success) {
      setAllGoals(goalsJson.data);
      const found = goalsJson.data.find((g) => g.id === id) ?? null;
      setGoal(found);
      if (found) {
        setNameValue(found.name);
        setDescValue(found.description ?? "");
      }
    }
    if (Array.isArray(tasksJson.data)) setTasks(tasksJson.data);
    setLoading(false);
  };

  useEffect(() => { void loadGoal(); }, [id]);

  useEffect(() => { if (editingName && nameRef.current) nameRef.current.focus(); }, [editingName]);
  useEffect(() => { if (editingDesc && descRef.current) descRef.current.focus(); }, [editingDesc]);

  const patchGoal = async (patch: Partial<Pick<HierarchyGoal, "name" | "description" | "status" | "level" | "deliverables">>) => {
    if (!goal) return;
    setSaving(true);
    await fetch("/api/hierarchy/goals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: goal.id, ...patch }),
    });
    await loadGoal();
    setSaving(false);
  };

  const saveName = async () => {
    const trimmed = nameValue.trim();
    setEditingName(false);
    if (!trimmed || trimmed === goal?.name) return;
    await patchGoal({ name: trimmed });
  };

  const saveDesc = async () => {
    setEditingDesc(false);
    if (descValue.trim() === (goal?.description ?? "")) return;
    await patchGoal({ description: descValue.trim() || null });
  };

  const addDeliverable = async () => {
    const trimmed = newDeliverable.trim();
    if (!trimmed || !goal) return;
    if (goal.deliverables.includes(trimmed)) { setNewDeliverable(""); return; }
    setSavingDeliverable(true);
    await patchGoal({ deliverables: [...goal.deliverables, trimmed] });
    setNewDeliverable("");
    setSavingDeliverable(false);
  };

  const removeDeliverable = async (item: string) => {
    if (!goal) return;
    setSavingDeliverable(true);
    await patchGoal({ deliverables: goal.deliverables.filter((d) => d !== item) });
    setSavingDeliverable(false);
  };

  if (loading) {
    return (
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="text-sm text-muted-foreground animate-pulse">Loading goal…</div>
          </main>
        </div>
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            <Button variant="ghost" size="sm" onClick={() => router.push("/hierarchy")} className="mb-4">
              ← Back to Hierarchy
            </Button>
            <p className="text-sm text-muted-foreground">Goal not found.</p>
          </main>
        </div>
      </div>
    );
  }

  const subGoals = allGoals.filter((g) => g.parentGoalId === goal.id);
  const openTasks = tasks.filter((t) => t.status !== "done");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const blockedTasks = tasks.filter((t) => t.status === "blocked");

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Back + breadcrumb */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button onClick={() => router.push("/hierarchy")} className="hover:text-foreground transition-colors">
              Hierarchy
            </button>
            <span>/</span>
            {goal.organizationName && (
              <>
                <span>{goal.organizationName}</span>
                <span>/</span>
              </>
            )}
            {goal.parentGoalName && (
              <>
                <button
                  onClick={() => router.push(`/hierarchy/goal/${goal.parentGoalId}`)}
                  className="hover:text-foreground transition-colors"
                >
                  {goal.parentGoalName}
                </button>
                <span>/</span>
              </>
            )}
            <span className="text-foreground">{goal.name}</span>
          </div>

          {/* Title block */}
          <div className="border border-terminal-red/30 bg-card p-5 space-y-3">
            <div className="flex flex-wrap items-start gap-3">
              {/* Inline-editable name */}
              <div className="flex-1 min-w-0">
                {editingName ? (
                  <input
                    ref={nameRef}
                    className="w-full text-xl font-bold bg-transparent border-b border-terminal-red/60 outline-none"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onBlur={() => void saveName()}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") { setEditingName(false); setNameValue(goal.name); } }}
                    disabled={saving}
                  />
                ) : (
                  <h1
                    className="text-xl font-bold cursor-text hover:text-terminal-red/80 transition-colors"
                    title="Click to edit"
                    onClick={() => { setNameValue(goal.name); setEditingName(true); }}
                  >
                    {goal.name}
                  </h1>
                )}
              </div>

              {/* Status + level selects */}
              <div className="flex items-center gap-2 shrink-0">
                <select
                  className={`border px-2 py-1 text-[11px] font-mono uppercase tracking-wide bg-background cursor-pointer focus:outline-none ${STATUS_COLORS[goal.status] ?? ""} disabled:opacity-40`}
                  value={goal.status}
                  disabled={saving}
                  onChange={(e) => void patchGoal({ status: e.target.value as HierarchyGoal["status"] })}
                >
                  <option value="planned">PLANNED</option>
                  <option value="active">ACTIVE</option>
                  <option value="blocked">BLOCKED</option>
                  <option value="done">DONE</option>
                </select>
                <select
                  className="border border-blue-500/30 px-2 py-1 text-[11px] font-mono uppercase tracking-wide bg-background text-blue-400/80 cursor-pointer focus:outline-none disabled:opacity-40"
                  value={goal.level ?? ""}
                  disabled={saving}
                  onChange={(e) => void patchGoal({ level: (e.target.value as HierarchyGoal["level"]) || null })}
                >
                  <option value="">— LEVEL —</option>
                  <option value="vision">VISION</option>
                  <option value="mission">MISSION</option>
                  <option value="objective">OBJECTIVE</option>
                  <option value="key_result">KEY RESULT</option>
                </select>
              </div>
            </div>

            {/* Org + parent */}
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {goal.organizationName && <Badge variant="secondary">{goal.organizationName}</Badge>}
              {goal.parentGoalName && (
                <Badge variant="outline" className="cursor-pointer" onClick={() => router.push(`/hierarchy/goal/${goal.parentGoalId}`)}>
                  ↑ {goal.parentGoalName}
                </Badge>
              )}
            </div>

            {/* Inline-editable description */}
            {editingDesc ? (
              <textarea
                ref={descRef}
                rows={4}
                className="w-full text-sm bg-transparent border border-terminal-red/40 rounded p-2 outline-none resize-none text-muted-foreground"
                value={descValue}
                onChange={(e) => setDescValue(e.target.value)}
                onBlur={() => void saveDesc()}
                onKeyDown={(e) => { if (e.key === "Escape") { setEditingDesc(false); setDescValue(goal.description ?? ""); } }}
                disabled={saving}
              />
            ) : (
              <p
                className="text-sm text-muted-foreground cursor-text hover:text-foreground/70 transition-colors"
                title="Click to edit description"
                onClick={() => { setDescValue(goal.description ?? ""); setEditingDesc(true); }}
              >
                {goal.description || <span className="italic opacity-50">Click to add description…</span>}
              </p>
            )}

            {/* Quick actions */}
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => {
                const params = new URLSearchParams({ org: goal.organizationId ?? "", goal: goal.id });
                router.push(`/boards?${params.toString()}`);
              }}>View in Boards</Button>
              <Button size="sm" variant="outline" onClick={() => {
                const desc = goal.description ? ` — ${goal.description.slice(0, 120)}` : "";
                const topic = `Should "${goal.name}"${desc} be escalated in priority? Argue for increasing focus vs maintaining current ${goal.status} status. Consider team capacity, blockers, and org-level impact.`;
                const params = new URLSearchParams({ topic, goal: goal.id });
                if (goal.organizationId) params.set("org", goal.organizationId);
                router.push(`/council?${params.toString()}`);
              }}>Start Council Vote</Button>
              <Button size="sm" variant="ghost" onClick={() => router.push("/hierarchy")}>← Back</Button>
            </div>
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="border border-border bg-background">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="sub-goals">
                Sub-Goals {subGoals.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({subGoals.length})</span>}
              </TabsTrigger>
              <TabsTrigger value="tasks">
                Tasks {tasks.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({tasks.length})</span>}
              </TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview" className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-border p-4 text-center">
                  <div className="text-2xl font-bold text-terminal-red">{openTasks.length}</div>
                  <div className="text-[11px] font-mono uppercase text-muted-foreground mt-1">Open Tasks</div>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <div className="text-2xl font-bold text-green-400">{doneTasks.length}</div>
                  <div className="text-[11px] font-mono uppercase text-muted-foreground mt-1">Done</div>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <div className="text-2xl font-bold">{subGoals.length}</div>
                  <div className="text-[11px] font-mono uppercase text-muted-foreground mt-1">Sub-Goals</div>
                </div>
              </div>

              <div className="rounded-lg border border-border p-4 space-y-2">
                <div className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">Deliverables</div>
                <div className="flex flex-wrap gap-2">
                  {goal.deliverables.map((d) => (
                    <span key={d} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px]">
                      {d}
                      <button
                        onClick={() => void removeDeliverable(d)}
                        disabled={savingDeliverable}
                        className="text-muted-foreground hover:text-terminal-red transition-colors leading-none disabled:opacity-40"
                        title="Remove"
                      >×</button>
                    </span>
                  ))}
                  {goal.deliverables.length === 0 && (
                    <span className="text-[11px] text-muted-foreground italic">No deliverables yet.</span>
                  )}
                </div>
                <div className="flex gap-2 pt-1">
                  <input
                    className="flex-1 min-w-0 text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-terminal-red/50"
                    placeholder="Add deliverable…"
                    value={newDeliverable}
                    disabled={savingDeliverable}
                    onChange={(e) => setNewDeliverable(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void addDeliverable(); }}
                  />
                  <Button size="sm" variant="outline" disabled={!newDeliverable.trim() || savingDeliverable} onClick={() => void addDeliverable()}>
                    Add
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* Sub-Goals */}
            <TabsContent value="sub-goals" className="mt-4">
              {subGoals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sub-goals yet.</p>
              ) : (
                <div className="space-y-2">
                  {subGoals.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-3 rounded border border-border px-4 py-3 cursor-pointer hover:border-terminal-red/40 transition-colors"
                      onClick={() => router.push(`/hierarchy/goal/${sub.id}`)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{sub.name}</div>
                        {sub.description && (
                          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{sub.description}</div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[9px] font-mono uppercase ${STATUS_COLORS[sub.status] ?? ""}`}
                      >
                        {sub.status}
                      </Badge>
                      {sub.level && (
                        <Badge variant="outline" className="shrink-0 text-[9px] font-mono text-blue-400/80 border-blue-500/30">
                          {sub.level.replace("_", " ")}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Tasks */}
            <TabsContent value="tasks" className="mt-4">
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks linked to this goal yet.</p>
              ) : (
                <div className="space-y-1">
                  {/* Summary bar */}
                  <div className="flex gap-3 text-[10px] font-mono text-muted-foreground mb-3">
                    <span className="text-yellow-400">{openTasks.length} open</span>
                    <span>·</span>
                    <span className="text-green-400">{doneTasks.length} done</span>
                    {blockedTasks.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-terminal-red">{blockedTasks.length} blocked</span>
                      </>
                    )}
                  </div>
                  {tasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-3 rounded border border-border/50 px-3 py-2 text-sm">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${TASK_STATUS_COLORS[task.status] ?? ""}`}>
                        {task.status.replace("_", " ")}
                      </span>
                      <span className="flex-1 truncate">{task.title}</span>
                      {task.assignedAgentName && (
                        <span className="shrink-0 text-[10px] text-muted-foreground font-mono">{task.assignedAgentName}</span>
                      )}
                      {task.priority && task.priority !== "medium" && (
                        <Badge variant="outline" className={`shrink-0 text-[9px] uppercase ${task.priority === "high" ? "border-orange-500/50 text-orange-400" : task.priority === "low" ? "border-muted text-muted-foreground" : ""}`}>
                          {task.priority}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
