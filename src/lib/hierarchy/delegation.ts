import { listAgentRoles } from "@/lib/agents/roles";
import { listHierarchyOrganizationMembers } from "@/lib/hierarchy/organizations";

type RoleEdge = {
  agentId: string;
  reportsTo: string | null;
};

function getRoleEdges(organizationId?: string | null): RoleEdge[] {
  if (organizationId) {
    return listHierarchyOrganizationMembers(organizationId).map((member) => ({
      agentId: member.agent.id,
      reportsTo: member.role.reportsTo,
    }));
  }
  return listAgentRoles().map((role) => ({
    agentId: role.agentId,
    reportsTo: role.reportsTo,
  }));
}

export function getManagedAgentIds(managerAgentId: string, organizationId?: string | null): Set<string> {
  const edges = getRoleEdges(organizationId);
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.reportsTo) continue;
    const list = childrenByParent.get(edge.reportsTo) ?? [];
    list.push(edge.agentId);
    childrenByParent.set(edge.reportsTo, list);
  }
  const managed = new Set<string>();
  const queue = [...(childrenByParent.get(managerAgentId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (managed.has(current)) continue;
    managed.add(current);
    queue.push(...(childrenByParent.get(current) ?? []));
  }
  return managed;
}

export function canAgentAssignTarget(params: {
  requesterAgentId?: string | null;
  targetAgentId?: string | null;
  organizationId?: string | null;
}): boolean {
  const requesterAgentId = String(params.requesterAgentId || "").trim();
  const targetAgentId = String(params.targetAgentId || "").trim();
  if (!requesterAgentId || !targetAgentId) return true;
  if (requesterAgentId === targetAgentId) return true;
  const managed = getManagedAgentIds(requesterAgentId, params.organizationId);
  return managed.has(targetAgentId);
}
