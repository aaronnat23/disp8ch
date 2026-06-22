"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Tag = {
  id: string;
  name: string;
  color: string;
  scope: "general" | "workflow" | "agent" | "task" | "template";
  sortOrder: number;
  usageCount: number;
};

type Agent = { id: string; name: string; isActive: boolean };
type Task = { id: string; title: string; boardName: string | null; assignedAgentName: string | null };
type Workflow = { id: string; name: string; isActive: boolean };

type TagMap = Record<string, Tag[]>;

type LinkTargetType = "agent" | "task" | "workflow";

const TAGS_UI_STATE_KEY = "disp8ch:tags-ui-state";

function tagMapToIds(map: TagMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [targetId, tags] of Object.entries(map)) {
    out[targetId] = tags.map((tag) => tag.id);
  }
  return out;
}

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  const [agentTagIds, setAgentTagIds] = useState<Record<string, string[]>>({});
  const [taskTagIds, setTaskTagIds] = useState<Record<string, string[]>>({});
  const [workflowTagIds, setWorkflowTagIds] = useState<Record<string, string[]>>({});

  const [loading, setLoading] = useState(true);
  const [savingTarget, setSavingTarget] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#38bdf8");
  const [newTagScope, setNewTagScope] = useState<Tag["scope"]>("general");
  const [creatingTag, setCreatingTag] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [tagsRes, agentsRes, tasksRes, workflowsRes] = await Promise.all([
        fetch("/api/tags"),
        fetch("/api/agents"),
        fetch("/api/boards/tasks"),
        fetch("/api/workflows"),
      ]);

      const tagsJson = await tagsRes.json();
      const agentsJson = await agentsRes.json();
      const tasksJson = await tasksRes.json();
      const workflowsJson = await workflowsRes.json();

      const nextTags = (tagsJson.success ? tagsJson.data : []) as Tag[];
      const nextAgents = (agentsJson.success ? agentsJson.data?.agents : []) as Agent[];
      const nextTasks = (tasksJson.success ? tasksJson.data : []) as Task[];
      const nextWorkflows = (workflowsJson.success ? workflowsJson.data : []) as Workflow[];

      setTags(nextTags);
      setAgents(nextAgents);
      setTasks(nextTasks);
      setWorkflows(nextWorkflows);

      const [agentLinksRes, taskLinksRes, workflowLinksRes] = await Promise.all([
        nextAgents.length > 0
          ? fetch(`/api/tags/links?targetType=agent&targetIds=${encodeURIComponent(nextAgents.map((a) => a.id).join(","))}`)
          : Promise.resolve(new Response(JSON.stringify({ success: true, data: {} }))),
        nextTasks.length > 0
          ? fetch(`/api/tags/links?targetType=task&targetIds=${encodeURIComponent(nextTasks.map((t) => t.id).join(","))}`)
          : Promise.resolve(new Response(JSON.stringify({ success: true, data: {} }))),
        nextWorkflows.length > 0
          ? fetch(`/api/tags/links?targetType=workflow&targetIds=${encodeURIComponent(nextWorkflows.map((w) => w.id).join(","))}`)
          : Promise.resolve(new Response(JSON.stringify({ success: true, data: {} }))),
      ]);

      const agentLinksJson = await agentLinksRes.json();
      const taskLinksJson = await taskLinksRes.json();
      const workflowLinksJson = await workflowLinksRes.json();

      setAgentTagIds(tagMapToIds((agentLinksJson.success ? agentLinksJson.data : {}) as TagMap));
      setTaskTagIds(tagMapToIds((taskLinksJson.success ? taskLinksJson.data : {}) as TagMap));
      setWorkflowTagIds(tagMapToIds((workflowLinksJson.success ? workflowLinksJson.data : {}) as TagMap));
    } finally {
      setLoading(false);
    }
  };

  useAfterUseful(() => {
    void loadAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TAGS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAGS_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  const saveTargetTags = async (
    targetType: LinkTargetType,
    targetId: string,
    tagIds: string[],
  ) => {
    const key = `${targetType}:${targetId}`;
    setSavingTarget(key);
    try {
      await fetch("/api/tags/links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, tagIds }),
      });
    } finally {
      setSavingTarget(null);
    }
  };

  const toggleTargetTag = async (
    targetType: LinkTargetType,
    targetId: string,
    current: string[],
    tagId: string,
    setState: Dispatch<SetStateAction<Record<string, string[]>>>,
  ) => {
    const exists = current.includes(tagId);
    const next = exists ? current.filter((value) => value !== tagId) : [...current, tagId];
    setState((prev) => ({ ...prev, [targetId]: next }));
    try {
      await saveTargetTags(targetType, targetId, next);
    } catch {
      setState((prev) => ({ ...prev, [targetId]: current }));
    }
  };

  const createTag = async () => {
    if (!newTagName.trim()) return;
    setCreatingTag(true);
    try {
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTagName.trim(),
          color: newTagColor,
          scope: newTagScope,
        }),
      });
      setNewTagName("");
      await loadAll();
    } finally {
      setCreatingTag(false);
    }
  };

  const deleteTag = async (tagId: string) => {
    await fetch(`/api/tags?id=${encodeURIComponent(tagId)}`, { method: "DELETE" });
    await loadAll();
  };

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="tags">
          <div className="mb-6 flex items-center justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold">Tags</h1>
              <p className="text-sm text-muted-foreground">
                Manage tags and apply them to agents, board tasks, and workflows.
              </p>
            </div>
            <Badge variant="outline">{tags.length} tags</Badge>
          </div>

          {!loading && tags.length === 0 ? (
            hideGettingStarted ? (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                <p className="text-sm text-muted-foreground">No tags created yet.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setHideGettingStarted(false)}
                >
                  Show Tips
                </Button>
              </div>
            ) : (
              <div className="mb-4 rounded-md border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Getting Started
                    </div>
                    <p className="mt-2 text-sm font-medium">Create tags to group agents, tasks, and workflows.</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Start with broad labels like client, priority, research, or automation. Once tags exist,
                      the assignment sections below let you apply them to each supported object type.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHideGettingStarted(true)}
                  >
                    Hide Tips
                  </Button>
                </div>
              </div>
            )
          ) : null}

          <div className="mb-4 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Create Tag</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Color</Label>
                  <Input value={newTagColor} onChange={(event) => setNewTagColor(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Scope</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={newTagScope}
                    onChange={(event) => setNewTagScope(event.target.value as Tag["scope"])}
                  >
                    <option value="general">general</option>
                    <option value="workflow">workflow</option>
                    <option value="agent">agent</option>
                    <option value="task">task</option>
                    <option value="template">template</option>
                  </select>
                </div>
                <Button onClick={createTag} disabled={creatingTag || !newTagName.trim()}>
                  {creatingTag ? "Creating..." : "Create Tag"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tag Catalog</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading tags...</p>
                ) : tags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tags created yet.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {tags.map((tag) => (
                      <div key={tag.id} className="rounded-md border p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-sm font-medium" style={{ color: tag.color }}>
                            {tag.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-destructive"
                            onClick={() => void deleteTag(tag.id)}
                          >
                            Delete
                          </Button>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {tag.scope} • used {tag.usageCount} times
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Agent Tags</CardTitle>
              </CardHeader>
              <CardContent>
                {agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No agents yet.</p>
                ) : (
                  <div className="space-y-3">
                    {agents.map((agent) => {
                      const selected = agentTagIds[agent.id] ?? [];
                      const key = `agent:${agent.id}`;
                      return (
                        <div key={`agent-tags-${agent.id}`} className="rounded-md border p-3">
                          <div className="mb-2 flex items-center gap-2">
                            <ShapeAvatar seed={agent.id} size={24} />
                            <span className="text-sm font-medium">{agent.name}</span>
                            {!agent.isActive ? <Badge variant="outline">inactive</Badge> : null}
                            {savingTarget === key ? <Badge variant="secondary">saving...</Badge> : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {tags.map((tag) => (
                              <label key={`${agent.id}-${tag.id}`} className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={selected.includes(tag.id)}
                                  onChange={() =>
                                    void toggleTargetTag("agent", agent.id, selected, tag.id, setAgentTagIds)
                                  }
                                />
                                <span style={{ color: tag.color }}>{tag.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Task Tags</CardTitle>
              </CardHeader>
              <CardContent>
                {tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No board tasks yet.</p>
                ) : (
                  <div className="space-y-3">
                    {tasks.map((task) => {
                      const selected = taskTagIds[task.id] ?? [];
                      const key = `task:${task.id}`;
                      return (
                        <div key={`task-tags-${task.id}`} className="rounded-md border p-3">
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-sm font-medium">{task.title}</span>
                            <Badge variant="outline">{task.boardName || "board"}</Badge>
                            {task.assignedAgentName ? <Badge variant="secondary">{task.assignedAgentName}</Badge> : null}
                            {savingTarget === key ? <Badge variant="secondary">saving...</Badge> : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {tags.map((tag) => (
                              <label key={`${task.id}-${tag.id}`} className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={selected.includes(tag.id)}
                                  onChange={() =>
                                    void toggleTargetTag("task", task.id, selected, tag.id, setTaskTagIds)
                                  }
                                />
                                <span style={{ color: tag.color }}>{tag.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workflow Tags</CardTitle>
              </CardHeader>
              <CardContent>
                {workflows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workflows yet.</p>
                ) : (
                  <div className="space-y-3">
                    {workflows.map((workflow) => {
                      const selected = workflowTagIds[workflow.id] ?? [];
                      const key = `workflow:${workflow.id}`;
                      return (
                        <div key={`workflow-tags-${workflow.id}`} className="rounded-md border p-3">
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-sm font-medium">{workflow.name}</span>
                            <Badge variant={workflow.isActive ? "default" : "outline"}>
                              {workflow.isActive ? "active" : "inactive"}
                            </Badge>
                            {savingTarget === key ? <Badge variant="secondary">saving...</Badge> : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {tags.map((tag) => (
                              <label key={`${workflow.id}-${tag.id}`} className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={selected.includes(tag.id)}
                                  onChange={() =>
                                    void toggleTargetTag("workflow", workflow.id, selected, tag.id, setWorkflowTagIds)
                                  }
                                />
                                <span style={{ color: tag.color }}>{tag.name}</span>
                              </label>
                            ))}
                          </div>

                          {selected.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {selected.map((tagId) => {
                                const tag = tagsById.get(tagId);
                                if (!tag) return null;
                                return (
                                  <span
                                    key={`${workflow.id}-active-${tagId}`}
                                    className="rounded px-1.5 py-0.5 text-[10px]"
                                    style={{ backgroundColor: `${tag.color}33`, color: tag.color }}
                                  >
                                    {tag.name}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </main>
  );
}
