import { getLiveSession } from "@/lib/live-sessions/store";
import { getNotebook, listNotebookNotes } from "@/lib/notebooks/store";
import type { DynamicWorkflowPlan } from "./types";

const MAX_SOURCE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 24_000;

function bounded(value: string, max = MAX_SOURCE_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function timestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function resolveDynamicWorkflowSourceContext(plan: DynamicWorkflowPlan): string[] {
  const resolved: string[] = [];
  let total = 0;

  for (const source of plan.sourceRefs ?? []) {
    if (total >= MAX_TOTAL_CHARS) break;
    const type = String(source.type || "source").trim().toLowerCase();
    const id = String(source.id || "").trim();
    const label = String(source.label || source.type || "Source").trim();
    let content = `Source: ${label}\nType: ${type}${id ? `\nID: ${id}` : ""}${source.url ? `\nURL: ${source.url}` : ""}`;

    try {
      if ((type === "live-session" || type === "live_session") && id) {
        const session = getLiveSession(id);
        if (session) {
          const transcript = session.segments
            .filter((segment) => segment.status === "complete" && segment.text.trim())
            .map((segment) => `[${timestamp(segment.startMs)}-${timestamp(segment.endMs)}]${segment.speakerLabel ? ` ${segment.speakerLabel}:` : ""} ${segment.text.trim()}`)
            .join("\n");
          content += `\nTitle: ${session.title}\nTranscript:\n${transcript || "No completed transcript segments."}`;
        } else {
          content += "\nStatus: source record not found";
        }
      } else if (type === "notebook" && id) {
        const notebook = getNotebook(id);
        if (notebook) {
          const notes = listNotebookNotes(id)
            .slice(0, 12)
            .map((note) => `## ${note.title}\n${note.contentMd}`)
            .join("\n\n");
          content += `\nNotebook: ${notebook.name}\nNotes:\n${notes || "No notebook notes."}`;
        } else {
          content += "\nStatus: source record not found";
        }
      }
    } catch {
      content += "\nStatus: source could not be resolved";
    }

    const remaining = MAX_TOTAL_CHARS - total;
    const item = bounded(content, Math.min(MAX_SOURCE_CHARS, remaining));
    if (item.trim()) {
      resolved.push(item);
      total += item.length;
    }
  }

  return resolved;
}
