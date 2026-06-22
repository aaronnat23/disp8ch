import { getSqlite } from "@/lib/db";
import { resolveSecretValue, upsertSecret } from "@/lib/secrets/store";
import { nanoid } from "nanoid";

export type WorkflowCredential = {
  id: string;
  name: string;
  serviceType: string;
  secretRef: string;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicWorkflowCredential = Omit<WorkflowCredential, "secretRef"> & {
  secretRef: string;
  maskedSecretRef: string;
};

export function listWorkflowCredentials(): WorkflowCredential[] {
  const db = getSqlite();
  const rows = db.prepare("SELECT * FROM workflow_credentials ORDER BY created_at").all() as Array<Record<string, unknown>>;
  return rows.map(rowToCredential);
}

export function toPublicWorkflowCredential(credential: WorkflowCredential): PublicWorkflowCredential {
  const secretName = credential.secretRef.startsWith("secret:")
    ? credential.secretRef.slice(7)
    : "inline";
  return {
    ...credential,
    secretRef: credential.secretRef.startsWith("secret:") ? `secret:${secretName}` : "inline:masked",
    maskedSecretRef: credential.secretRef.startsWith("secret:")
      ? `secret:${secretName.slice(0, 4)}...${secretName.slice(-4)}`
      : "inline:masked",
  };
}

export function getWorkflowCredential(id: string): WorkflowCredential | null {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflow_credentials WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToCredential(row) : null;
}

export function createWorkflowCredential(params: {
  name: string;
  serviceType: string;
  secretValue: string;
  metadataJson?: string | null;
}): WorkflowCredential {
  const id = nanoid(12);
  const secretName = `WF_CRED_${id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
  upsertSecret({ name: secretName, value: params.secretValue, source: "workflow-credentials" });
  const now = new Date().toISOString();
  const db = getSqlite();
  db.prepare(
    "INSERT INTO workflow_credentials (id, name, service_type, secret_ref, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, params.name, params.serviceType, `secret:${secretName}`, params.metadataJson ?? null, now, now);
  return getWorkflowCredential(id)!;
}

export function updateWorkflowCredential(id: string, updates: Partial<{ name: string; serviceType: string; metadataJson: string | null }>): WorkflowCredential | null {
  const existing = getWorkflowCredential(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const db = getSqlite();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.serviceType !== undefined) { fields.push("service_type = ?"); values.push(updates.serviceType); }
  if (updates.metadataJson !== undefined) { fields.push("metadata_json = ?"); values.push(updates.metadataJson); }
  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  db.prepare(`UPDATE workflow_credentials SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getWorkflowCredential(id);
}

export function deleteWorkflowCredential(id: string): void {
  const db = getSqlite();
  db.prepare("DELETE FROM workflow_credentials WHERE id = ?").run(id);
}

export function resolveCredentialValue(secretRef: string): string | null {
  if (secretRef.startsWith("secret:")) {
    return resolveSecretValue(secretRef.slice(7).trim().toUpperCase()) ?? null;
  }
  return secretRef || null;
}

export async function testCredential(id: string): Promise<{ ok: boolean; status: string; checkedAt?: string }> {
  const cred = getWorkflowCredential(id);
  if (!cred) return { ok: false, status: "credential not found" };
  const value = resolveCredentialValue(cred.secretRef);
  if (!value) return { ok: false, status: "secret value is empty or unresolvable" };
  const { getWorkflowCredentialAdapter } = await import("@/lib/workflows/credential-adapters");
  const result = await getWorkflowCredentialAdapter(cred.serviceType).test(cred);
  return { ok: result.ok, status: result.status, checkedAt: result.checkedAt };
}

function rowToCredential(row: Record<string, unknown>): WorkflowCredential {
  return {
    id: String(row.id),
    name: String(row.name),
    serviceType: String(row.service_type),
    secretRef: String(row.secret_ref),
    metadataJson: row.metadata_json ? String(row.metadata_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
