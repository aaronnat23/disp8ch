import { getActiveHierarchyOrganization } from "@/lib/hierarchy/organizations";
import { listHierarchyGoals } from "@/lib/hierarchy/goals";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const hierarchyRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    const organization = getActiveHierarchyOrganization();
    if (!organization) {
      return "Hierarchy guidance:\n- No active organization snapshot is selected.";
    }
    return `Hierarchy guidance:\n- Active organization: ${organization.name}\n- Delegate work through the org structure and keep assignments aligned with manager/reporting lines when possible.`;
  },
  handleCommand(message) {
    if (!/^show\s+hierarchy\s+extension\s+status$/i.test(message.trim())) return null;
    const organization = getActiveHierarchyOrganization();
    const goals = listHierarchyGoals({ organizationId: organization?.id ?? undefined });
    return [
      "Hierarchy Control",
      `Active organization: ${organization?.name ?? "none"}`,
      `Goals in scope: ${goals.length}`,
    ].join("\n");
  },
  getStatus() {
    const organization = getActiveHierarchyOrganization();
    const goals = listHierarchyGoals({ organizationId: organization?.id ?? undefined });
    return {
      activeOrganizationId: organization?.id ?? null,
      activeOrganizationName: organization?.name ?? null,
      goalCount: goals.length,
    };
  },
};

export default hierarchyRuntime;
