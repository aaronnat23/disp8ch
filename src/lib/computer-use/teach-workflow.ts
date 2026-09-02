import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getSessionRecord, listSessionActions } from "@/lib/computer-use/session-store";
import { classifyComputerAction } from "@/lib/computer-use/policy";

const ACTIONABLE_KINDS = new Set(["launch_app", "focus_app", "click", "type", "set_value", "hotkey", "scroll", "drag", "wait"]);

function sanitizeCapturedValue(value: unknown, kind: string, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (/password|secret|token|api.?key|credential|authorization|cookie/i.test(key)) return "{{secret}}";
  if (kind === "type" && key === "text") return "{{input_text}}";
  if (kind === "set_value" && key === "value") return "{{input_value}}";
  if ((kind === "type" || kind === "set_value") && ["evidence", "query", "reason"].includes(key)) return "[verification text redacted]";
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeCapturedValue(entry, kind, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([childKey, childValue]) => [
      childKey,
      sanitizeCapturedValue(childValue, kind, childKey, depth + 1),
    ]));
  }
  return typeof value === "string" ? value.slice(0, 12_000) : value;
}

export function createTeachWorkflowDraft(input: { sessionId: string; name?: string; successCriteria?: string }) {
  const session = getSessionRecord(input.sessionId);
  if (!session) throw new Error(`Computer-use session not found: ${input.sessionId}`);
  const auditedActions = listSessionActions(input.sessionId, 500);
  const actions = auditedActions.flatMap((action) => {
    if (!ACTIONABLE_KINDS.has(action.kind) || action.result?.ok !== true) return [];
    const payload = action.payload ?? {};
    const classification = classifyComputerAction({
      kind: action.kind as Parameters<typeof classifyComputerAction>[0]["kind"],
      text: typeof payload.text === "string" ? payload.text : typeof payload.value === "string" ? payload.value : undefined,
      keys: Array.isArray(payload.keys) ? payload.keys.map(String) : undefined,
      target: typeof payload.target === "string" ? payload.target : null,
      appHint: null,
    });
    const effectiveRequiresApproval = action.requiresApproval || classification.requiresApproval;
    if (classification.blocked || (effectiveRequiresApproval && action.approved !== true)) return [];
    return [{ ...action, effectiveRequiresApproval, effectiveRisk: action.risk || classification.risk }];
  });
  if (actions.length === 0) throw new Error("This session has no successful, draftable actions.");

  const nodes = [
    {
      id: "trigger",
      type: "manual-trigger",
      position: { x: 80, y: 120 },
      data: { label: "Review and run manually", requiresReview: true },
    },
    ...actions.map((action, index) => ({
      id: `captured-${index + 1}`,
      type: "placeholder",
      position: { x: 360 + (index % 3) * 280, y: 120 + Math.floor(index / 3) * 190 },
      data: {
        label: `${index + 1}. ${action.kind.replace(/_/g, " ")}`,
        description: action.kind === "type" || action.kind === "set_value"
          ? `Captured ${action.kind.replace(/_/g, " ")} action; input text redacted.`
          : action.detail || `Captured ${action.kind} action`,
        capturedKind: action.kind,
        capturedArgs: sanitizeCapturedValue(action.payload ?? {}, action.kind),
        verification: sanitizeCapturedValue(action.result ?? null, action.kind),
        capturedAt: action.createdAt,
        sourceActionId: action.id,
        risk: action.effectiveRisk,
        requiresApproval: action.effectiveRequiresApproval,
        selectorStable: typeof action.payload?.element_index === "number"
          || (typeof action.payload?.element_token === "string" && action.payload.element_token.length > 0)
          || (typeof action.payload?.target === "string" && action.payload.target.length > 0),
        needsReview: true,
        reviewReason: "Replace this captured placeholder with a supported, selector-stable workflow step before activation.",
      },
    })),
    {
      id: "success-criteria",
      type: "sticky-note",
      position: { x: 360, y: 350 + Math.ceil(actions.length / 3) * 190 },
      data: {
        label: "Success criteria",
        content: input.successCriteria?.trim() || "Define an observable success condition and failure/rollback behavior before enabling this workflow.",
        capturedActions: actions.length,
        skippedActions: auditedActions.length - actions.length,
      },
    },
  ];
  const edges = actions.map((_, index) => ({
    id: `edge-${index}`,
    source: index === 0 ? "trigger" : `captured-${index}`,
    target: `captured-${index + 1}`,
  }));
  const id = nanoid(12);
  const now = new Date().toISOString();
  initializeDatabase();
  getSqlite().prepare(`INSERT INTO workflows (id, name, description, nodes, edges, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'computer-use-teach', ?, ?, 0, ?, ?)`)
    .run(
      id,
      input.name?.trim() || `Taught task: ${session.label || session.id}`,
      `Review-only workflow draft generated from ${actions.length} successful audited computer-use actions (${auditedActions.length - actions.length} non-replayable actions skipped). Captured text and secret-like fields were converted to variables.`,
      JSON.stringify(nodes),
      JSON.stringify(edges),
      session.id,
      JSON.stringify({ approval: { mode: "strict" }, taughtDraft: true, requiresReview: true, sourceSessionId: session.id, capturedActionCount: actions.length, skippedActionCount: auditedActions.length - actions.length }),
      now,
      now,
    );
  return { id, name: input.name?.trim() || `Taught task: ${session.label || session.id}`, actionCount: actions.length, skippedActionCount: auditedActions.length - actions.length, isActive: false, nodes, edges };
}
