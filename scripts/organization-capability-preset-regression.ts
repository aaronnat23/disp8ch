import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Check = { name: string; passed: boolean; detail?: string };

function record(checks: Check[], name: string, passed: unknown, detail?: string) {
  checks.push({ name, passed: Boolean(passed), detail });
}

async function main() {
  const checks: Check[] = [];
  const tempRoot = path.join(os.tmpdir(), `disp8ch-org-capability-${Date.now()}`);
  process.env.DATABASE_PATH = path.join(tempRoot, "disp8ch.db");
  process.env.WORKSPACE_PATH = path.join(tempRoot, "workspace");
  fs.mkdirSync(process.env.WORKSPACE_PATH, { recursive: true });

  try {
    const { initializeDatabase } = await import("@/lib/db");
    const { createAgent, getAgentById } = await import("@/lib/agents/registry");
    const {
      saveSelectedHierarchyOrganization,
      applyIntegrationPresetToHierarchyOrganization,
      getHierarchyOrganizationById,
    } = await import("@/lib/hierarchy/organizations");
    const { setGlobalExtensionEnabled } = await import("@/lib/extensions/state");

    initializeDatabase();
    const agent = createAgent({ id: "preset-regression-agent", name: "Preset Regression Agent" });
    const organization = saveSelectedHierarchyOrganization({
      name: "Preset Regression Organization",
      description: "Temporary release regression organization",
      activate: false,
      memberIds: [agent.id],
    });

    const applied = applyIntegrationPresetToHierarchyOrganization(organization.id, "hierarchy-lead");
    const updatedAgent = getAgentById(agent.id);
    record(
      checks,
      "preset merges skills and extensions into member",
      applied.updatedAgentIds.includes(agent.id) &&
        updatedAgent?.enabledExtensions.includes("hierarchy") &&
        updatedAgent?.enabledSkills.includes("hierarchy:team-delegation"),
      JSON.stringify(updatedAgent),
    );

    const refreshedOrganization = getHierarchyOrganizationById(organization.id);
    const member = refreshedOrganization?.snapshot.find((entry) => entry.agent.id === agent.id);
    record(
      checks,
      "organization snapshot refreshes after preset merge",
      member?.agent.enabledExtensions.includes("hierarchy") && member.agent.enabledSkills.includes("hierarchy:team-delegation"),
      JSON.stringify(member),
    );

    setGlobalExtensionEnabled("hierarchy", false);
    const before = JSON.stringify(getAgentById(agent.id));
    let blocked = false;
    try {
      applyIntegrationPresetToHierarchyOrganization(organization.id, "hierarchy-lead");
    } catch (error) {
      blocked = String(error).includes("disabled globally");
    }
    record(checks, "globally disabled extension blocks whole-team preset", blocked, "no partial member updates allowed");
    record(checks, "blocked preset leaves member unchanged", JSON.stringify(getAgentById(agent.id)) === before);
  } finally {
    try {
      const { getSqlite } = await import("@/lib/db");
      getSqlite().close();
    } catch {
      // The temporary database may not have initialized if setup failed.
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // A Windows file handle can outlive the test process briefly; leaving a
      // temp-only directory is preferable to hiding the test result.
    }
  }

  const passed = checks.filter((check) => check.passed).length;
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
  }
  console.log(`\norganization-capability-preset-regression: ${passed}/${checks.length} passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
