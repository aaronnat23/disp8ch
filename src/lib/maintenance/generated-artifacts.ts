import { getSqlite, initializeDatabase } from "@/lib/db";
import { unscheduleCronWorkflow } from "@/lib/cron/manager";
import { deleteDocument } from "@/lib/documents/store";
import { logger } from "@/lib/utils/logger";
import { extractCronNodes, parseWorkflowNodes } from "@/lib/agents/workflow-insights";

const log = logger.child("maintenance:generated-artifacts");

export const DEFAULT_SCHEDULED_TASK_RETENTION = 20;

const REGRESSION_MARKERS = ["api-regression-", "doc-cron-", "channel-parity-"];

type BoardTaskCleanupRow = {
  id: string;
  board_id: string;
  title: string;
  description: string | null;
  workflow_id: string | null;
  source_type: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowCleanupRow = {
  id: string;
  name: string;
  description: string | null;
  nodes: string;
  source_type: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type DocumentCleanupRow = {
  id: string;
  name: string;
  source_type: string;
  source_url: string | null;
  created_at: string;
};

export type GeneratedArtifactCleanupSummary = {
  deletedBoardTasks: number;
  deletedScheduledTasks: number;
  deletedRegressionBoardTasks: number;
  deletedWorkflows: number;
  deletedRegressionWorkflows: number;
  deletedOrphanBoardTaskWorkflows: number;
  deletedTestCronWorkflows: number;
  deletedDocuments: number;
  deletedRegressionDocuments: number;
  deletedDuplicateCrawlerDocuments: number;
  retainedScheduledTasksPerBoard: number;
  remainingScheduledTasks: number;
};

export function isRegressionArtifactText(text: string, markers: string[] = REGRESSION_MARKERS): boolean {
  const normalized = String(text || "").toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

export function isGeneratedScheduledTask(params: {
  title: string;
  description?: string | null;
  sourceType?: string | null;
}): boolean {
  if (String(params.sourceType || "").trim().toLowerCase() === "cron-generated") {
    return true;
  }

  const title = String(params.title || "").trim();
  const description = String(params.description || "").trim().toLowerCase();
  return title.startsWith("Scheduled check:") && description.includes("auto-created by cron workflow");
}

function hasRegressionDocumentName(name: string, markers: string[]): boolean {
  const trimmed = String(name || "").trim();
  if (!markers.some((marker) => marker.toLowerCase().includes("doc-cron-"))) {
    return false;
  }
  return /^doc-cron-\d+\.pdf$/i.test(trimmed) || /^Docs_Page_doc-cron-\d+$/i.test(trimmed);
}

function isCrawlerDuplicateCandidate(doc: DocumentCleanupRow): boolean {
  return (
    /^\d+\.\d+\.\d+_Documentation$/i.test(String(doc.name || "")) &&
    String(doc.source_type || "").toLowerCase() === "scrape" &&
    String(doc.source_url || "").trim() === "https://docs.python.org/3/"
  );
}

function deleteBoardTaskRows(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;
  initializeDatabase();
  const db = getSqlite();
  const deleteTask = db.prepare("DELETE FROM board_tasks WHERE id = ?");
  const deleteTags = db.prepare("DELETE FROM tag_links WHERE target_type = 'task' AND target_id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      deleteTask.run(id);
      deleteTags.run(id);
    }
  });
  tx(taskIds);
  return taskIds.length;
}

function deleteWorkflowRows(workflowIds: string[]): number {
  if (workflowIds.length === 0) return 0;
  initializeDatabase();
  const db = getSqlite();
  const clearLinkedTasks = db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id = ?");
  const deleteTags = db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?");
  const deleteWorkflow = db.prepare("DELETE FROM workflows WHERE id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      clearLinkedTasks.run(id);
      deleteTags.run(id);
      deleteWorkflow.run(id);
      unscheduleCronWorkflow(id);
    }
  });
  tx(workflowIds);
  return workflowIds.length;
}

export function pruneGeneratedScheduledBoardTasks(
  boardId: string,
  keep = DEFAULT_SCHEDULED_TASK_RETENTION,
): number {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare(
      `
        SELECT id, board_id, title, description, workflow_id, source_type, source_ref, created_at, updated_at
        FROM board_tasks
        WHERE board_id = ?
        ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all(boardId) as BoardTaskCleanupRow[];

  const scheduledRows = rows.filter((row) =>
    isGeneratedScheduledTask({
      title: row.title,
      description: row.description,
      sourceType: row.source_type,
    }),
  );
  const toDelete = scheduledRows.slice(Math.max(0, keep)).map((row) => row.id);
  const deleted = deleteBoardTaskRows(toDelete);
  if (deleted > 0) {
    log.info("Pruned generated scheduled board tasks", { boardId, keep, deleted });
  }
  return deleted;
}

export function cleanupGeneratedArtifacts(options?: {
  keepScheduledTasksPerBoard?: number;
  removeRegressionArtifacts?: boolean;
  removeOrphanBoardTaskWorkflows?: boolean;
  removeTestCronWorkflows?: boolean;
  artifactMarkers?: string[];
}): GeneratedArtifactCleanupSummary {
  const keepScheduledTasksPerBoard = Math.max(
    0,
    options?.keepScheduledTasksPerBoard ?? DEFAULT_SCHEDULED_TASK_RETENTION,
  );
  const removeRegressionArtifacts = options?.removeRegressionArtifacts !== false;
  const removeOrphanBoardTaskWorkflows = options?.removeOrphanBoardTaskWorkflows !== false;
  const removeTestCronWorkflows = options?.removeTestCronWorkflows === true;
  const artifactMarkers =
    options?.artifactMarkers && options.artifactMarkers.length > 0
      ? options.artifactMarkers
      : REGRESSION_MARKERS;

  initializeDatabase();
  const db = getSqlite();

  const boardTasks = db
    .prepare(
      `
        SELECT id, board_id, title, description, workflow_id, source_type, source_ref, created_at, updated_at
        FROM board_tasks
        ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as BoardTaskCleanupRow[];

  const tasksToDelete = new Set<string>();
  let deletedScheduledTasks = 0;
  let deletedRegressionBoardTasks = 0;

  const scheduledByBoard = new Map<string, BoardTaskCleanupRow[]>();
  for (const row of boardTasks) {
    if (
      isGeneratedScheduledTask({
        title: row.title,
        description: row.description,
        sourceType: row.source_type,
      })
    ) {
      const bucket = scheduledByBoard.get(row.board_id) ?? [];
      bucket.push(row);
      scheduledByBoard.set(row.board_id, bucket);
    }
  }

  for (const rows of scheduledByBoard.values()) {
    const extraRows = rows.slice(keepScheduledTasksPerBoard);
    for (const row of extraRows) {
      if (!tasksToDelete.has(row.id)) {
        tasksToDelete.add(row.id);
        deletedScheduledTasks += 1;
      }
    }
  }

  if (removeRegressionArtifacts) {
    for (const row of boardTasks) {
      if (isRegressionArtifactText(`${row.title}\n${row.description || ""}`, artifactMarkers)) {
        if (!tasksToDelete.has(row.id)) {
          tasksToDelete.add(row.id);
        }
        deletedRegressionBoardTasks += 1;
      }
    }
  }

  const workflowIdsFromDeletedTasks = new Set<string>();
  for (const row of boardTasks) {
    if (tasksToDelete.has(row.id) && row.workflow_id) {
      workflowIdsFromDeletedTasks.add(row.workflow_id);
    }
  }

  const taskIds = new Set(boardTasks.map((row) => row.id));
  const referencedWorkflowIds = new Set(
    boardTasks.map((row) => String(row.workflow_id || "").trim()).filter(Boolean),
  );

  const workflows = db
    .prepare(
      `
        SELECT id, name, description, nodes, source_type, source_ref, created_at, updated_at
        FROM workflows
        ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as WorkflowCleanupRow[];

  const workflowsToDelete = new Set<string>();
  let deletedRegressionWorkflows = 0;
  let deletedOrphanBoardTaskWorkflows = 0;
  let deletedTestCronWorkflows = 0;

  for (const row of workflows) {
    const sourceType = String(row.source_type || "").trim().toLowerCase();
    const sourceRef = String(row.source_ref || "").trim();
    const hasCronNodes = extractCronNodes(parseWorkflowNodes(row.nodes)).length > 0;
    const isRegressionWorkflow = removeRegressionArtifacts
      ? isRegressionArtifactText(`${row.name}\n${row.description || ""}`, artifactMarkers)
      : false;
    const isOrphanBoardTaskWorkflow =
      removeOrphanBoardTaskWorkflows &&
      sourceType === "board-task" &&
      sourceRef &&
      !taskIds.has(sourceRef);
    const isTestCronWorkflow =
      removeTestCronWorkflows &&
      hasCronNodes &&
      /^test(?:\b|\s|[-_:])/i.test(String(row.name || "").trim());
    const shouldDelete =
      workflowIdsFromDeletedTasks.has(row.id) ||
      isRegressionWorkflow ||
      isOrphanBoardTaskWorkflow ||
      isTestCronWorkflow ||
      (removeRegressionArtifacts &&
        String(row.name || "").startsWith("[Board Task]") &&
        !referencedWorkflowIds.has(row.id) &&
        isRegressionArtifactText(`${row.name}\n${row.description || ""}`, artifactMarkers));

    if (!shouldDelete || workflowsToDelete.has(row.id)) {
      continue;
    }

    workflowsToDelete.add(row.id);
    if (isRegressionWorkflow) {
      deletedRegressionWorkflows += 1;
    }
    if (isOrphanBoardTaskWorkflow) {
      deletedOrphanBoardTaskWorkflows += 1;
    }
    if (isTestCronWorkflow) {
      deletedTestCronWorkflows += 1;
    }
  }

  const documents = db
    .prepare(
      `
        SELECT id, name, source_type, source_url, created_at
        FROM documents
        ORDER BY created_at DESC
      `,
    )
    .all() as DocumentCleanupRow[];

  const documentsToDelete = new Set<string>();
  let deletedRegressionDocuments = 0;
  let deletedDuplicateCrawlerDocuments = 0;

  if (removeRegressionArtifacts) {
    const regressionDocs = documents.filter((doc) => hasRegressionDocumentName(doc.name, artifactMarkers));
    const keepLatestByBucket = new Map<string, boolean>();
    for (const doc of regressionDocs) {
      const bucket = /\.pdf$/i.test(doc.name) ? "doc-cron-pdf" : "doc-cron-page";
      if (!keepLatestByBucket.has(bucket)) {
        keepLatestByBucket.set(bucket, true);
        continue;
      }
      documentsToDelete.add(doc.id);
      deletedRegressionDocuments += 1;
    }

    if (artifactMarkers.some((marker) => marker.toLowerCase().includes("doc-cron-"))) {
      const crawlerDocs = documents.filter((doc) => isCrawlerDuplicateCandidate(doc));
      let keptCrawler = false;
      for (const doc of crawlerDocs) {
        if (!keptCrawler) {
          keptCrawler = true;
          continue;
        }
        documentsToDelete.add(doc.id);
        deletedDuplicateCrawlerDocuments += 1;
      }
    }
  }

  const deletedBoardTasks = deleteBoardTaskRows([...tasksToDelete]);
  const deletedWorkflows = deleteWorkflowRows([...workflowsToDelete]);

  let deletedDocuments = 0;
  for (const id of documentsToDelete) {
    if (deleteDocument(id)) {
      deletedDocuments += 1;
    }
  }

  const remainingScheduledTasks = (
    db.prepare(
      `
        SELECT COUNT(*) AS c
        FROM board_tasks
        WHERE
          source_type = 'cron-generated'
          OR (
            title LIKE 'Scheduled check:%'
            AND description LIKE 'Auto-created by cron workflow%'
          )
      `,
    ).get() as { c: number }
  ).c;

  const summary: GeneratedArtifactCleanupSummary = {
    deletedBoardTasks,
    deletedScheduledTasks,
    deletedRegressionBoardTasks,
    deletedWorkflows,
    deletedRegressionWorkflows,
    deletedOrphanBoardTaskWorkflows,
    deletedTestCronWorkflows,
    deletedDocuments,
    deletedRegressionDocuments,
    deletedDuplicateCrawlerDocuments,
    retainedScheduledTasksPerBoard: keepScheduledTasksPerBoard,
    remainingScheduledTasks,
  };

  log.info("Generated artifact cleanup completed", summary);
  return summary;
}

export function formatGeneratedArtifactCleanupSummary(
  summary: GeneratedArtifactCleanupSummary,
): string {
  return [
    "## Generated Artifact Cleanup",
    "",
    `- Board tasks deleted: ${summary.deletedBoardTasks}`,
    `- Scheduled tasks pruned: ${summary.deletedScheduledTasks}`,
    `- Regression board tasks deleted: ${summary.deletedRegressionBoardTasks}`,
    `- Workflows deleted: ${summary.deletedWorkflows}`,
    `- Regression workflows deleted: ${summary.deletedRegressionWorkflows}`,
    `- Orphan board-task workflows deleted: ${summary.deletedOrphanBoardTaskWorkflows}`,
    `- Test cron workflows deleted: ${summary.deletedTestCronWorkflows}`,
    `- Documents deleted: ${summary.deletedDocuments}`,
    `- Regression documents deleted: ${summary.deletedRegressionDocuments}`,
    `- Duplicate crawler documents deleted: ${summary.deletedDuplicateCrawlerDocuments}`,
    `- Scheduled task retention per board: ${summary.retainedScheduledTasksPerBoard}`,
    `- Remaining scheduled tasks: ${summary.remainingScheduledTasks}`,
  ].join("\n");
}
