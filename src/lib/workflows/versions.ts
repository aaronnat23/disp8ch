import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";

export type WorkflowVersion = {
  id: string;
  workflowId: string;
  version: number;
  name: string;
  description: string | null;
  nodesJson: string;
  edgesJson: string;
  metadataJson: string | null;
  createdAt: string;
};

export function snapshotWorkflowVersion(params: {
  workflowId: string;
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Why the snapshot was taken, e.g. "manual", "save", "pre-restore", "n8n-import". */
  reason?: string;
  metadata?: Record<string, unknown> | null;
}): WorkflowVersion {
  const db = getSqlite();
  const id = nanoid(12);
  const now = new Date().toISOString();

  const lastVersion = db.prepare(
    "SELECT MAX(version) as max_version FROM workflow_versions WHERE workflow_id = ?",
  ).get(params.workflowId) as { max_version: number | null } | undefined;
  const version = (lastVersion?.max_version ?? 0) + 1;

  // Always record reason + node/edge counts so the version list is scannable.
  const metadata: Record<string, unknown> = {
    ...(params.metadata ?? {}),
    reason: params.reason ?? (params.metadata?.reason as string | undefined) ?? "manual",
    nodeCount: params.nodes.length,
    edgeCount: params.edges.length,
  };

  db.prepare(
    `INSERT INTO workflow_versions (id, workflow_id, version, name, description, nodes_json, edges_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, params.workflowId, version, params.name,
    params.description ?? null,
    JSON.stringify(params.nodes), JSON.stringify(params.edges),
    JSON.stringify(metadata),
    now,
  );

  return listWorkflowVersions(params.workflowId).find((v) => v.id === id)!;
}

/**
 * Whether the topology (node/edge ids or node types) changed between two graphs.
 * Used to snapshot on save only when the graph actually changed.
 */
export function workflowTopologyChanged(
  prev: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  next: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
): boolean {
  if (prev.nodes.length !== next.nodes.length || prev.edges.length !== next.edges.length) return true;
  const sig = (g: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => {
    const nodeSig = g.nodes.map((n) => `${n.id}:${n.type}`).sort().join("|");
    const edgeSig = g.edges.map((e) => `${e.source}>${e.target}:${e.sourceHandle ?? ""}`).sort().join("|");
    return `${nodeSig}__${edgeSig}`;
  };
  return sig(prev) !== sig(next);
}

export function listWorkflowVersions(workflowId: string): WorkflowVersion[] {
  const db = getSqlite();
  const rows = db.prepare(
    "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC",
  ).all(workflowId) as Array<Record<string, unknown>>;
  return rows.map(rowToVersion);
}

export function getWorkflowVersion(id: string): WorkflowVersion | null {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflow_versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToVersion(row) : null;
}

export function restoreWorkflowVersion(versionId: string): WorkflowVersion | null {
  const version = getWorkflowVersion(versionId);
  if (!version) return null;
  const db = getSqlite();

  // Snapshot the current workflow before overwriting so a restore is reversible.
  const current = db
    .prepare("SELECT name, description, nodes, edges FROM workflows WHERE id = ?")
    .get(version.workflowId) as { name: string; description: string | null; nodes: string; edges: string } | undefined;
  if (current) {
    try {
      snapshotWorkflowVersion({
        workflowId: version.workflowId,
        name: current.name,
        description: current.description,
        nodes: JSON.parse(current.nodes) as WorkflowNode[],
        edges: JSON.parse(current.edges) as WorkflowEdge[],
        reason: "pre-restore",
      });
    } catch {
      // If the current graph cannot be parsed, still proceed with restore.
    }
  }

  const nodes = JSON.parse(version.nodesJson);
  const edges = JSON.parse(version.edgesJson);
  db.prepare("UPDATE workflows SET nodes = ?, edges = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(nodes), JSON.stringify(edges),
    new Date().toISOString(), version.workflowId,
  );
  return version;
}

export function diffWorkflowVersions(
  versionIdA: string,
  versionIdB: string,
): { addedNodeIds: string[]; removedNodeIds: string[]; addedEdgeIds: string[]; removedEdgeIds: string[] } | null {
  const vA = getWorkflowVersion(versionIdA);
  const vB = getWorkflowVersion(versionIdB);
  if (!vA || !vB) return null;

  const nodesA = JSON.parse(vA.nodesJson) as WorkflowNode[];
  const nodesB = JSON.parse(vB.nodesJson) as WorkflowNode[];
  const edgesA = JSON.parse(vA.edgesJson) as WorkflowEdge[];
  const edgesB = JSON.parse(vB.edgesJson) as WorkflowEdge[];

  const nodeIdsA = new Set(nodesA.map((n) => n.id));
  const nodeIdsB = new Set(nodesB.map((n) => n.id));
  const edgeIdsA = new Set(edgesA.map((e) => e.id));
  const edgeIdsB = new Set(edgesB.map((e) => e.id));

  return {
    addedNodeIds: Array.from(nodeIdsB).filter((id) => !nodeIdsA.has(id)),
    removedNodeIds: Array.from(nodeIdsA).filter((id) => !nodeIdsB.has(id)),
    addedEdgeIds: Array.from(edgeIdsB).filter((id) => !edgeIdsA.has(id)),
    removedEdgeIds: Array.from(edgeIdsA).filter((id) => !edgeIdsB.has(id)),
  };
}

function rowToVersion(row: Record<string, unknown>): WorkflowVersion {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    version: Number(row.version),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    nodesJson: String(row.nodes_json),
    edgesJson: String(row.edges_json),
    metadataJson: row.metadata_json ? String(row.metadata_json) : null,
    createdAt: String(row.created_at),
  };
}
