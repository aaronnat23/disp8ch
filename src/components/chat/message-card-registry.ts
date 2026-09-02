import type { ChatMessage } from "@/types/channel";

export type MessagePresentationCard = {
  id: string;
  title: string;
  kind?: "browser" | "council" | "memory" | "tool" | "workflow" | "performance";
  tone?: "warning" | "default";
  rows: Array<[string, string]>;
  detail?: string;
  action?: { label: string; href: string };
};

export type MessageCardPresenter = (message: ChatMessage) => MessagePresentationCard[];

const presenters = new Map<string, MessageCardPresenter>();

function presentationScalar(value: unknown, maxLength: number): string | null {
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, maxLength);
  if (typeof value === "boolean") return String(value);
  return null;
}

export function registerMessageCardPresenter(id: string, presenter: MessageCardPresenter): () => void {
  presenters.set(id, presenter);
  return () => presenters.delete(id);
}

export function presentRegisteredMessageCards(message: ChatMessage): MessagePresentationCard[] {
  const cards: MessagePresentationCard[] = [];
  for (const presenter of presenters.values()) {
    try { cards.push(...presenter(message)); } catch { /* presenters are optional */ }
  }
  const declared = message.metadata?.presentationCards;
  if (Array.isArray(declared)) {
    declared.slice(0, 8).forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const value = raw as Record<string, unknown>;
      const title = presentationScalar(value.title, 80)?.trim();
      if (!title || !Array.isArray(value.rows)) return;
      const declaredId = String(value.id || index).replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || String(index);
      const actionValue = value.action && typeof value.action === "object"
        ? value.action as Record<string, unknown>
        : null;
      const actionHref = presentationScalar(actionValue?.href, 500) ?? "";
      const actionLabel = presentationScalar(actionValue?.label, 80)?.trim() || "Open";
      cards.push({
        id: `declared-${declaredId}`,
        title,
        kind: ["browser", "council", "memory", "tool", "workflow", "performance"].includes(String(value.kind)) ? value.kind as MessagePresentationCard["kind"] : "tool",
        tone: value.tone === "warning" ? "warning" : "default",
        rows: (value.rows as unknown[]).slice(0, 12).flatMap((row) => {
          if (!Array.isArray(row) || row.length < 2) return [];
          const label = presentationScalar(row[0], 40)?.trim();
          const content = presentationScalar(row[1], 500);
          return label && content !== null ? [[label, content] as [string, string]] : [];
        }),
        detail: presentationScalar(value.detail, 2000) ?? undefined,
        action: actionValue && actionHref.startsWith("/") && !actionHref.startsWith("//") && !actionHref.includes("\\") && !/[\u0000-\u001f\u007f]/.test(actionHref)
          ? { label: actionLabel, href: actionHref }
          : undefined,
      });
    });
  }
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (!card.rows.length || seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  }).slice(0, 12);
}

function numericMetadata(message: ChatMessage, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = message.metadata?.[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

registerMessageCardPresenter("core-selected-context", (message) => {
  const value = message.metadata?.selectedContext;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const context = value as Record<string, unknown>;
  return [{
    id: "selected-context",
    title: "Selected Context",
    kind: "memory",
    rows: [
      ["agent", String(context.agentId ?? "default")],
      ["model", String(context.modelRef ?? "inherit")],
      ["tools", String(context.toolMode ?? "default")],
      ["workspace", String(context.workspacePath ?? "default")],
      ["speed", context.fastMode === true ? "fast" : context.fastMode === false ? "standard" : "auto"],
    ],
  }];
});

registerMessageCardPresenter("core-performance", (message) => {
  const durationMs = numericMetadata(message, "durationMs", "latencyMs");
  const ttftMs = numericMetadata(message, "ttftMs");
  const queueMs = numericMetadata(message, "queueMs");
  const cachedTokens = numericMetadata(message, "cachedTokens", "cacheReadTokens");
  const tokensUsed = numericMetadata(message, "tokensUsed");
  if (durationMs === null && ttftMs === null && queueMs === null && cachedTokens === null && tokensUsed === null) return [];
  return [{
    id: "performance",
    title: "Performance",
    kind: "performance",
    rows: [
      ...(queueMs !== null ? [["queue", `${Math.round(queueMs)} ms`] as [string, string]] : []),
      ...(ttftMs !== null ? [["first token", `${Math.round(ttftMs)} ms`] as [string, string]] : []),
      ...(durationMs !== null ? [["total", `${Math.round(durationMs)} ms`] as [string, string]] : []),
      ...(tokensUsed !== null ? [["usage", `${Math.round(tokensUsed)} tokens`] as [string, string]] : []),
      ...(cachedTokens !== null ? [["cached", `${Math.round(cachedTokens)} tokens`] as [string, string]] : []),
    ],
  }];
});
