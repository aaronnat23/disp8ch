import { logger } from "@/lib/utils/logger";
import {
  getRun,
  getCommand as getStoredCommand,
  listCommands as listStoredCommands,
  saveCommand,
  deleteCommand as deleteStoredCommand,
  updateRunSavedCommandName,
} from "./store";
import type {
  DynamicWorkflowCommandRecord,
  DynamicWorkflowPlan,
} from "./types";

const log = logger.child("dynamic-workflows:commands");

function validateCommandName(name: string): string {
  const trimmed = name.replace(/^\//, "").trim();
  if (!trimmed) throw new Error("Command name is required");
  if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) {
    throw new Error(`Invalid command name: ${trimmed}`);
  }
  return trimmed;
}

export function saveRunAsCommand(
  runId: string,
  commandName: string,
): DynamicWorkflowCommandRecord {
  const name = validateCommandName(commandName);
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "completed") {
    throw new Error(
      `Run must be completed to save as command. Current status: ${run.status}`,
    );
  }

  let planTemplate: DynamicWorkflowPlan;
  try {
    planTemplate = JSON.parse(run.planJson) as DynamicWorkflowPlan;
  } catch {
    throw new Error(`Run ${runId} has invalid plan JSON`);
  }

  const existing = getStoredCommand(name);
  if (existing) {
    throw new Error(
      `Command "/${name}" already exists. Delete it first or choose a different name.`,
    );
  }

  const command = saveCommand({
    name,
    description: run.description ?? `Saved from run "${run.name}"`,
    planTemplateJson: JSON.stringify(planTemplate),
    defaultModelRef: run.modelRef,
    defaultMaxConcurrency: run.maxConcurrency,
    createdFromRunId: runId,
  });

  updateRunSavedCommandName(runId, name);

  log.info("Saved run as command", { runId, commandName: name });
  return command;
}

export function getCommand(
  name: string,
): DynamicWorkflowCommandRecord | null {
  const trimmed = name.replace(/^\//, "").trim();
  if (!trimmed) return null;
  return getStoredCommand(trimmed) ?? null;
}

export function listCommands(): DynamicWorkflowCommandRecord[] {
  return listStoredCommands();
}

export function deleteCommand(name: string): boolean {
  const trimmed = name.replace(/^\//, "").trim();
  if (!trimmed) return false;
  const command = getStoredCommand(trimmed);
  if (!command) return false;
  const deleted = deleteStoredCommand(trimmed);
  if (!deleted) return false;

  if (command.createdFromRunId) {
    try {
      updateRunSavedCommandName(command.createdFromRunId, null);
    } catch {
      // Best-effort: the run might have been deleted.
    }
  }

  log.info("Deleted command", { commandName: trimmed });
  return true;
}

export function resolveCommandPlan(
  commandName: string,
): DynamicWorkflowPlan | null {
  const command = getCommand(commandName);
  if (!command) return null;
  try {
    return JSON.parse(command.planTemplateJson) as DynamicWorkflowPlan;
  } catch {
    log.warn("Failed to parse plan template for command", { commandName });
    return null;
  }
}
