import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listAgentRoles,
  updateAgentRole,
  type AgentRoleType,
} from "@/lib/agents/roles";
import { listAgents } from "@/lib/agents/registry";
import { listHierarchyOrganizationMembers } from "@/lib/hierarchy/organizations";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const RoleTypeSchema = z.enum([
  "orchestrator",
  "operations",
  "specialist",
  "worker",
  "support",
]);

const UpdateRoleSchema = z.object({
  agentId: z.string().min(1),
  roleType: RoleTypeSchema.optional(),
  roleTitle: z.string().max(120).optional(),
  roleDescription: z.string().max(600).optional(),
  reportsTo: z.string().min(1).nullable().optional(),
  capabilities: z.array(z.string().min(1).max(60)).max(20).optional(),
  voteWeight: z.number().int().min(1).max(9).optional(),
});

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("Agent not found")) return 404;
  if (message.includes("Invalid chain of command")) return 400;
  return 500;
}

function roleWeight(roleType: AgentRoleType): number {
  if (roleType === "orchestrator") return 0;
  if (roleType === "operations") return 1;
  if (roleType === "specialist") return 2;
  if (roleType === "worker") return 3;
  return 4;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") || searchParams.get("org");

    if (organizationId) {
      const members = listHierarchyOrganizationMembers(organizationId);
      const memberIds = new Set(members.map((member) => member.agent.id));
      const data = members
        .map((member) => ({
          agentId: member.agent.id,
          agentName: member.agent.name,
          agentActive: member.agentActive,
          isDefault: member.agent.isDefault,
          roleType: member.role.roleType,
          roleTitle: member.role.roleTitle,
          roleDescription: member.role.roleDescription,
          reportsTo: member.role.reportsTo && memberIds.has(member.role.reportsTo)
            ? member.role.reportsTo
            : null,
          capabilities: member.role.capabilities,
          voteWeight: member.role.voteWeight,
        }))
        .sort((a, b) => {
          const byRole = roleWeight(a.roleType) - roleWeight(b.roleType);
          if (byRole !== 0) return byRole;
          if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
          return a.agentName.localeCompare(b.agentName);
        });

      return NextResponse.json({
        success: true,
        data,
      });
    }

    const agents = listAgents();
    const roles = listAgentRoles();
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    const data = roles
      .map((role) => {
        const agent = agentsById.get(role.agentId);
        if (!agent) return null;
        return {
          ...role,
          agentName: agent.name,
          agentActive: agent.isActive,
          isDefault: agent.isDefault,
        };
      })
      .filter((item) => Boolean(item))
      .sort((a, b) => {
        const one = a!;
        const two = b!;
        const byRole = roleWeight(one.roleType) - roleWeight(two.roleType);
        if (byRole !== 0) return byRole;
        if (one.isDefault !== two.isDefault) return one.isDefault ? -1 : 1;
        return one.agentName.localeCompare(two.agentName);
      });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateRoleSchema.parse(body);
    const updated = updateAgentRole(parsed.agentId, {
      roleType: parsed.roleType,
      roleTitle: parsed.roleTitle,
      roleDescription: parsed.roleDescription,
      reportsTo: parsed.reportsTo,
      capabilities: parsed.capabilities,
      voteWeight: parsed.voteWeight,
    });
    return NextResponse.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
