export type WorkObjectRef = {
  workObjectType: "board_task" | "goal" | "hierarchy_org" | "workflow_run" | "document";
  workObjectId: string;
  taskKey?: string;
};

export type CoalescedWakeup = {
  id: string;
  agentId: string;
  workObject: WorkObjectRef;
  triggerType: "assignment" | "mention" | "schedule" | "manual" | "automation";
  triggerSource: string;
  status: "queued" | "claimed" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  queuedAt: string;
  claimedAt?: string;
  finishedAt?: string;
  coalescedFrom: string[];
  runId?: string;
};

const activeWakeups = new Map<string, CoalescedWakeup>();

function wakeupKey(agentId: string, workObject: WorkObjectRef): string {
  return `${agentId}:${workObject.workObjectType}:${workObject.workObjectId}`;
}

export function shouldCoalesceWakeup(agentId: string, workObject: WorkObjectRef): boolean {
  const key = wakeupKey(agentId, workObject);
  const existing = activeWakeups.get(key);
  if (!existing) return false;
  return existing.status === "queued" || existing.status === "claimed" || existing.status === "running";
}

export function coalesceWakeup(params: {
  agentId: string;
  workObject: WorkObjectRef;
  triggerType: CoalescedWakeup["triggerType"];
  triggerSource: string;
}): { coalesced: boolean; wakeup: CoalescedWakeup } {
  const key = wakeupKey(params.agentId, params.workObject);
  const existing = activeWakeups.get(key);

  if (existing && (existing.status === "queued" || existing.status === "claimed" || existing.status === "running")) {
    existing.coalescedFrom.push(`${params.triggerType}:${params.triggerSource}:${Date.now()}`);
    return { coalesced: true, wakeup: existing };
  }

  const wakeup: CoalescedWakeup = {
    id: `wu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId: params.agentId,
    workObject: params.workObject,
    triggerType: params.triggerType,
    triggerSource: params.triggerSource,
    status: "queued",
    queuedAt: new Date().toISOString(),
    coalescedFrom: [],
  };
  activeWakeups.set(key, wakeup);
  return { coalesced: false, wakeup };
}

export function claimWakeup(agentId: string, workObject: WorkObjectRef, runId: string): CoalescedWakeup | null {
  const key = wakeupKey(agentId, workObject);
  const existing = activeWakeups.get(key);
  if (!existing || existing.status !== "queued") return null;
  existing.status = "claimed";
  existing.claimedAt = new Date().toISOString();
  existing.runId = runId;
  return existing;
}

export function completeWakeup(agentId: string, workObject: WorkObjectRef, status: CoalescedWakeup["status"]): CoalescedWakeup | null {
  const key = wakeupKey(agentId, workObject);
  const existing = activeWakeups.get(key);
  if (!existing || (existing.status !== "claimed" && existing.status !== "running")) return null;
  existing.status = status;
  existing.finishedAt = new Date().toISOString();
  return existing;
}

export function startWakeupRun(agentId: string, workObject: WorkObjectRef): CoalescedWakeup | null {
  const key = wakeupKey(agentId, workObject);
  const existing = activeWakeups.get(key);
  if (!existing || existing.status !== "claimed") return null;
  existing.status = "running";
  return existing;
}

export function getActiveWakeupsForAgent(agentId: string): CoalescedWakeup[] {
  return Array.from(activeWakeups.values()).filter(
    (w) => w.agentId === agentId && ["queued", "claimed", "running"].includes(w.status),
  );
}

export function getActiveWakeupsForWorkObject(workObject: WorkObjectRef): CoalescedWakeup[] {
  return Array.from(activeWakeups.values()).filter(
    (w) => w.workObject.workObjectType === workObject.workObjectType &&
        w.workObject.workObjectId === workObject.workObjectId &&
        ["queued", "claimed", "running"].includes(w.status),
  );
}
