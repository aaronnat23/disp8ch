import { listWorkflowCredentials, toPublicWorkflowCredential } from "@/lib/workflows/credentials";
import type { WorkflowNode } from "@/types/workflow";

export type WorkflowCredentialHealth = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  credentialRef: string | null;
  serviceType: string | null;
  status: "ok" | "missing" | "untested" | "not_required";
  message: string;
};

function readNodeData(node: WorkflowNode): Record<string, unknown> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const config = data.config && typeof data.config === "object" ? (data.config as Record<string, unknown>) : {};
  return { ...config, ...data };
}

function inferServiceType(node: WorkflowNode, data: Record<string, unknown>): string | null {
  const nodeType = String(node.type || "");
  const explicit = data.serviceType ?? data.provider ?? data.integration;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().toLowerCase();
  if (/google/i.test(nodeType)) return "google";
  if (/slack/i.test(nodeType)) return "slack";
  if (/notion/i.test(nodeType)) return "notion";
  if (/airtable/i.test(nodeType)) return "airtable";
  if (/email|smtp/i.test(nodeType)) return "email";
  if (/http/i.test(nodeType)) return "http";
  return null;
}

function findCredentialRef(data: Record<string, unknown>): string | null {
  const keys = ["credentialId", "credentialRef", "credentials", "secretRef", "authCredentialId"];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested = record.id ?? record.credentialId ?? record.credentialRef ?? record.secretRef;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return null;
}

export function inspectWorkflowCredentialHealth(nodes: WorkflowNode[]): {
  items: WorkflowCredentialHealth[];
  summary: { ok: number; missing: number; untested: number; notRequired: number };
} {
  const credentials = listWorkflowCredentials().map(toPublicWorkflowCredential);
  const byId = new Map(credentials.map((credential) => [credential.id, credential]));
  const byName = new Map(credentials.map((credential) => [credential.name.trim().toLowerCase(), credential]));
  const bySecretRef = new Map(credentials.map((credential) => [credential.secretRef.trim().toLowerCase(), credential]));

  const items = nodes.map((node): WorkflowCredentialHealth => {
    const data = readNodeData(node);
    const credentialRef = findCredentialRef(data);
    const serviceType = inferServiceType(node, data);
    const nodeName = String(data.label || node.id);
    const nodeType = String(node.type || "unknown");
    const needsCredential =
      Boolean(credentialRef) ||
      /google|slack|notion|airtable|email|smtp|discord|telegram|teams|bluebubbles|http-request/i.test(nodeType);

    if (!needsCredential) {
      return {
        nodeId: node.id,
        nodeName,
        nodeType,
        credentialRef: null,
        serviceType,
        status: "not_required",
        message: "Node does not require a stored credential.",
      };
    }

    if (!credentialRef) {
      return {
        nodeId: node.id,
        nodeName,
        nodeType,
        credentialRef: null,
        serviceType,
        status: "missing",
        message: "Credential is required but no credential reference is configured.",
      };
    }

    const credential =
      byId.get(credentialRef) ??
      byName.get(credentialRef.toLowerCase()) ??
      bySecretRef.get(credentialRef.toLowerCase()) ??
      null;
    if (!credential) {
      return {
        nodeId: node.id,
        nodeName,
        nodeType,
        credentialRef,
        serviceType,
        status: "missing",
        message: "Credential reference does not match a saved credential.",
      };
    }
    return {
      nodeId: node.id,
      nodeName,
      nodeType,
      credentialRef: credential.id,
      serviceType: credential.serviceType,
      status: "ok",
      message: "Credential reference resolves to a saved credential.",
    };
  });

  return {
    items,
    summary: {
      ok: items.filter((item) => item.status === "ok").length,
      missing: items.filter((item) => item.status === "missing").length,
      untested: items.filter((item) => item.status === "untested").length,
      notRequired: items.filter((item) => item.status === "not_required").length,
    },
  };
}
