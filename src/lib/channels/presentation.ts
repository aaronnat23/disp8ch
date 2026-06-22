import { stripMemoryContextBlocks } from "@/lib/memory/context-sanitizer";

export type PresentationChannel =
  | "telegram"
  | "discord"
  | "whatsapp"
  | "webchat"
  | "google-chat"
  | "slack"
  | "bluebubbles"
  | "teams";

function normalizeText(text: string): string {
  return stripMemoryContextBlocks(String(text || "").replace(/\r\n/g, "\n")).trim();
}

function replaceLinks(text: string, formatter: (label: string, url: string) => string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) =>
    formatter(label, url),
  );
}

function stripInlineMarkdown(text: string): string {
  return replaceLinks(text, (label, url) => `${label}: ${url}`)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

const PRESENTATION_FIELD_PREFIXES = new Set([
  "match",
  "title",
  "status",
  "task id",
  "workflow",
  "execution",
  "board",
  "total",
  "cron",
  "timezone",
  "setting",
  "value",
  "generated",
  "target host",
  "summary",
  "document",
  "id",
  "agent",
  "model",
  "tokens used",
  "tokens in",
  "tokens out",
]);

function isPresentationFieldLine(text: string): boolean {
  const plain = stripInlineMarkdown(text).trim();
  if (!plain.includes(":")) return false;
  const prefix = plain.split(":", 1)[0]?.trim().toLowerCase() ?? "";
  return PRESENTATION_FIELD_PREFIXES.has(prefix);
}

function isStandaloneSectionHeading(text: string): boolean {
  const plain = stripInlineMarkdown(text).replace(/^"+|"+$/g, "").trim();
  if (!plain || plain.length > 72) return false;
  if (!/[A-Za-z]/.test(plain)) return false;
  if (/^[a-z0-9_-]{1,16}$/.test(plain)) return false;
  if (/^[A-Za-z0-9]+-[A-Za-z0-9-]{2,}$/.test(plain) && !/\s/.test(plain)) return false;
  if (/^[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/.test(plain)) return false;
  if (isPresentationFieldLine(plain)) return false;
  if (/^[#>*|`]/.test(plain)) return false;
  if (/^[-*•]\s+/.test(plain)) return false;
  if (/^\d+\.\s+/.test(plain)) return false;
  if (/^https?:\/\//i.test(plain)) return false;
  if (/[.!?]$/.test(plain)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 /&()'_-]{2,}$/.test(plain);
}

function normalizeWorkflowNarrative(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      normalized.push("");
      continue;
    }

    if (/^[•●]\s+/.test(trimmed)) {
      normalized.push(`- ${trimmed.replace(/^[•●]\s+/, "")}`);
      continue;
    }

    const colonHeading = trimmed.match(/^([A-Za-z][A-Za-z0-9 /&()'_-]{2,}):$/);
    if (
      colonHeading?.[1] &&
      !isPresentationFieldLine(trimmed) &&
      colonHeading[1].length <= 48 &&
      colonHeading[1].trim().split(/\s+/).length <= 6
    ) {
      normalized.push(`## ${colonHeading[1].trim()}`);
      continue;
    }

    if (isStandaloneSectionHeading(trimmed)) {
      const prev = lines[index - 1]?.trim() ?? "";
      const next = lines[index + 1]?.trim() ?? "";
      const looksLikeSection =
        !prev ||
        !next ||
        /^[-*•]/.test(next) ||
        /^\d+\.\s+/.test(next) ||
        next.startsWith("|") ||
        next.includes(":");
      if (looksLikeSection) {
        normalized.push(`## ${trimmed}`);
        continue;
      }
    }

    normalized.push(line);
  }

  return normalized.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decorateHeading(title: string): string {
  const plain = stripInlineMarkdown(title)
    .replace(/^"+|"+$/g, "")
    .trim();
  const normalized = plain.toLowerCase();

  if (normalized.includes("scope of the documentation")) return `📘 ${plain}`;
  if (normalized.includes("key concepts") || normalized.includes("apis")) return `🔑 ${plain}`;
  if (normalized.includes("quickstart") || normalized.includes("learning path")) return `🚀 ${plain}`;
  if (normalized.includes("caveats") || normalized.includes("limitations")) return `⚠️ ${plain}`;
  if (normalized.includes("follow-up prompts") || normalized.includes("follow up prompts")) {
    return `💬 ${plain}`;
  }
  return plain;
}

type PresentedTask = {
  title: string;
  status: string;
  id: string;
};

type PresentedSchedule = {
  name: string;
  expression: string;
  timezone: string;
  state: string;
};

type TaskSelectionInfo =
  | {
      requested: string;
      matchedTitle: string;
      matchedId: string;
      matchedCount: number;
    }
  | null;

function normalizeTaskStatusLabel(status: string): string {
  return String(status || "")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase();
}

function formatTaskStatusLabel(status: string): string {
  const normalized = normalizeTaskStatusLabel(status);
  return normalized || "unknown";
}

function formatScheduleState(state: string): string {
  const normalized = String(state || "")
    .trim()
    .toLowerCase();
  if (normalized === "live") return "live";
  if (normalized === "disabled") return "disabled";
  if (normalized === "inactive") return "inactive";
  return normalized || "unknown";
}

function parseCompactTaskLine(line: string): PresentedTask | null {
  const match = line.match(/^\d+\.\s+\[([^\]]+)\]\s+(.+?)\s+\(([A-Za-z0-9_-]{6,})\)\s*$/);
  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    return null;
  }
  return {
    status: normalizeTaskStatusLabel(match[1]),
    title: match[2].trim(),
    id: match[3].trim(),
  };
}

function parseStructuredTaskBlocks(lines: string[]): PresentedTask[] {
  const tasks: PresentedTask[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const titleMatch = lines[i]?.match(/^\d+\.\s+(.+)$/);
    if (!titleMatch?.[1]) continue;

    const statusLine = lines[i + 1]?.trim() ?? "";
    const idLine = lines[i + 2]?.trim() ?? "";
    const statusMatch = statusLine.match(/^status:\s*(.+)$/i);
    const idMatch = idLine.match(/^id:\s*([A-Za-z0-9_-]{6,})$/i);

    if (!statusMatch?.[1] || !idMatch?.[1]) {
      continue;
    }

    tasks.push({
      title: titleMatch[1].trim(),
      status: normalizeTaskStatusLabel(statusMatch[1]),
      id: idMatch[1].trim(),
    });
    i += 2;
  }

  return tasks;
}

function parseTaskList(text: string): {
  label: string;
  total: number;
  tasks: PresentedTask[];
  startIndex: number;
  endIndex: number;
} | null {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const headerLine = lines[0]?.replace(/^[^\w]+/, "").trim() ?? "";
  const headerMatch = headerLine.match(/^(Inbox|Main Board|Board)\s+tasks(?:\s+on\s+main-board)?\s+\((\d+)\s+total\):$/i);
  if (!headerMatch?.[1] || !headerMatch?.[2]) {
    return null;
  }

  let startIndex = 1;
  let endIndex = 0;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    const rangeMatch = trimmed.match(/^Showing (\d+)-(\d+) of (\d+)\./i);
    if (rangeMatch?.[1] && rangeMatch?.[2]) {
      startIndex = Number(rangeMatch[1]);
      endIndex = Number(rangeMatch[2]);
      break;
    }
  }

  const taskLines = lines.slice(1).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^Showing first \d+ of \d+\.$/i.test(trimmed)) return false;
    if (/^Showing \d+-\d+ of \d+\./i.test(trimmed)) return false;
    return true;
  });

  const compactTasks = taskLines
    .map((line) => parseCompactTaskLine(line))
    .filter((task): task is PresentedTask => Boolean(task));
  const tasks = compactTasks.length > 0 ? compactTasks : parseStructuredTaskBlocks(taskLines);
  if (tasks.length === 0) {
    return null;
  }

  if (startIndex === 1) {
    const firstTaskLine = taskLines.find((line) => /^\d+\.\s+/.test(line.trim()));
    const firstTaskNumber = firstTaskLine?.trim().match(/^(\d+)\.\s+/)?.[1];
    if (firstTaskNumber) {
      startIndex = Number(firstTaskNumber);
    }
  }

  return {
    label: headerMatch[1],
    total: Number(headerMatch[2]),
    tasks,
    startIndex,
    endIndex: endIndex || startIndex + tasks.length - 1,
  };
}

function parseScheduleList(text: string): { total: number; schedules: PresentedSchedule[] } | null {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const headerMatch = lines[0]?.trim().match(/^Scheduled workflows \((\d+)\):$/i);
  if (!headerMatch?.[1]) {
    return null;
  }

  const schedules = lines
    .slice(1)
    .map((line) => {
      const match = line.match(/^[•*-]\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+)$/);
      if (!match?.[1] || !match?.[2] || !match?.[3] || !match?.[4]) {
        return null;
      }
      return {
        name: match[1].trim(),
        expression: match[2].trim(),
        timezone: match[3].trim(),
        state: formatScheduleState(match[4]),
      };
    })
    .filter((schedule): schedule is PresentedSchedule => Boolean(schedule));

  if (schedules.length === 0) {
    return null;
  }

  return {
    total: Number(headerMatch[1]),
    schedules,
  };
}

function parseTaskSelectionPrefix(text: string): { selection: TaskSelectionInfo; remainder: string } {
  const manyMatch = text.match(
    /^Matched (\d+) tasks for "([^"]+)". Using the most recent match: "([^"]+)" \(([A-Za-z0-9_-]{6,})\)\.\n+([\s\S]+)$/i,
  );
  if (manyMatch?.[1] && manyMatch?.[2] && manyMatch?.[3] && manyMatch?.[4] && manyMatch?.[5]) {
    return {
      selection: {
        requested: manyMatch[2].trim(),
        matchedTitle: manyMatch[3].trim(),
        matchedId: manyMatch[4].trim(),
        matchedCount: Number(manyMatch[1]),
      },
      remainder: manyMatch[5],
    };
  }

  const directMatch = text.match(
    /^Matched "([^"]+)" to "([^"]+)" \(([A-Za-z0-9_-]{6,})\)\.\n+([\s\S]+)$/i,
  );
  if (directMatch?.[1] && directMatch?.[2] && directMatch?.[3] && directMatch?.[4]) {
    return {
      selection: {
        requested: directMatch[1].trim(),
        matchedTitle: directMatch[2].trim(),
        matchedId: directMatch[3].trim(),
        matchedCount: 1,
      },
      remainder: directMatch[4],
    };
  }

  return {
    selection: null,
    remainder: text,
  };
}

function formatPresentedTaskStart(params: {
  taskId: string;
  title: string;
  status: string;
  workflowName?: string | null;
  executionId?: string | null;
  selection: TaskSelectionInfo;
  suffix?: string | null;
}): string {
  const lines = ["## Task Started", ""];

  if (params.selection) {
    if (params.selection.matchedCount > 1) {
      lines.push(
        `Match: ${params.selection.requested} -> ${params.selection.matchedTitle} (${params.selection.matchedCount} matches, newest selected)`,
      );
    } else {
      lines.push(`Match: ${params.selection.requested} -> ${params.selection.matchedTitle}`);
    }
    lines.push("");
  }

  lines.push(`Title: ${params.title}`);
  lines.push(`Status: ${formatTaskStatusLabel(params.status)}`);
  lines.push(`Task ID: ${params.taskId}`);
  if (params.workflowName) {
    lines.push(`Workflow: ${params.workflowName}`);
  }
  if (params.executionId) {
    lines.push(`Execution: ${params.executionId}`);
  }
  if (params.suffix?.trim()) {
    lines.push("", normalizeWorkflowNarrative(params.suffix.trim()));
  }

  return lines.join("\n");
}

function formatPresentedTaskList(list: {
  label: string;
  total: number;
  tasks: PresentedTask[];
  startIndex: number;
  endIndex: number;
}): string {
  const normalizedLabel = String(list.label || "").trim().toLowerCase();
  const isInboxList = normalizedLabel === "inbox";
  const isOpenList = normalizedLabel === "open";
  const isCompletedList = normalizedLabel === "completed" || normalizedLabel === "done";
  const visibleTasks = list.tasks.slice(0, 6);
  const body = visibleTasks
    .map((task, index) => {
      return `${list.startIndex + index}. ${task.title}\nStatus: ${formatTaskStatusLabel(task.status)}\nTask ID: ${task.id}`;
    })
    .join("\n\n");

  const moreLine =
    list.endIndex < list.total
      ? `\n\nShowing ${list.startIndex}-${Math.min(list.endIndex, list.total)} of ${list.total}.`
      : "";

  if (isInboxList) {
    return `## Board Tasks\n\nInbox Tasks\nBoard: main-board\nTotal: ${list.total}\n\n${body}${moreLine}`;
  }
  if (isOpenList) {
    return `## Board Tasks\n\nOpen Tasks\nBoard: main-board\nTotal: ${list.total}\n\n${body}${moreLine}`;
  }
  if (isCompletedList) {
    return `## Board Tasks\n\nCompleted Tasks\nBoard: main-board\nTotal: ${list.total}\n\n${body}${moreLine}`;
  }
  return `## ${list.label} Tasks\n\nBoard: main-board\nTotal: ${list.total}\n\n${body}${moreLine}`;
}

function formatPresentedScheduleList(list: { total: number; schedules: PresentedSchedule[] }): string {
  const visibleSchedules = list.schedules.slice(0, 6);
  const body = visibleSchedules
    .map((schedule, index) => {
      return [
        `${index + 1}. ${schedule.name}`,
        `Cron: ${schedule.expression}`,
        `Timezone: ${schedule.timezone}`,
        `Status: ${schedule.state}`,
      ].join("\n");
    })
    .join("\n\n");

  const moreLine =
    list.total > visibleSchedules.length
      ? `\n\nShowing first ${visibleSchedules.length} of ${list.total}.`
      : "";

  return `## Scheduled Workflows\n\nCron Jobs\nTotal: ${list.total}\n\n${body}${moreLine}`;
}

function rewriteStructuredResponses(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        response?: unknown;
        success?: unknown;
        data?: unknown;
        agentName?: unknown;
        model?: unknown;
        tokensUsed?: unknown;
        tokensIn?: unknown;
        tokensOut?: unknown;
      };
      if (typeof parsed.response === "string" && parsed.response.trim()) {
        return rewriteStructuredResponses(parsed.response.trim());
      }
      if (parsed.data && typeof parsed.data === "object") {
        const data = parsed.data as {
          response?: unknown;
          id?: unknown;
          title?: unknown;
          status?: unknown;
          boardId?: unknown;
          boardName?: unknown;
        };
        if (typeof data.response === "string" && data.response.trim()) {
          return rewriteStructuredResponses(data.response.trim());
        }
        if (parsed.success === true && typeof data.id === "string" && typeof data.title === "string") {
          return [
            "## Workflow Result",
            "",
            `Title: ${data.title}`,
            `Status: ${formatTaskStatusLabel(String(data.status || ""))}`,
            `Task ID: ${data.id}`,
            `Board: ${String(data.boardName || data.boardId || "main-board")}`,
          ].join("\n");
        }
      }
      if (
        typeof parsed.agentName === "string" &&
        typeof parsed.model === "string" &&
        (parsed.tokensUsed !== undefined || parsed.tokensIn !== undefined || parsed.tokensOut !== undefined)
      ) {
        return "The workflow completed, but it did not return a user-facing summary.";
      }
    } catch {
      // Ignore invalid JSON and continue with text-format parsing.
    }
  }

  const taskList = parseTaskList(text);
  if (taskList) {
    return formatPresentedTaskList(taskList);
  }

  const scheduleList = parseScheduleList(text);
  if (scheduleList) {
    return formatPresentedScheduleList(scheduleList);
  }

  const { selection, remainder } = parseTaskSelectionPrefix(text);
  const taskStarted = remainder.match(
    /^Task\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\s+\("([^"]+)"\)\s+moved to\s+\*{0,2}([A-Za-z_]+)\*{0,2}\s+and started workflow\s+\*{0,2}(.+?)\*{0,2}\s+\(execution\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\)\.(?:\n+([\s\S]+))?$/i,
  );
  if (taskStarted?.[1] && taskStarted?.[2] && taskStarted?.[3] && taskStarted?.[4] && taskStarted?.[5]) {
    return formatPresentedTaskStart({
      taskId: taskStarted[1].trim(),
      title: taskStarted[2].trim(),
      status: taskStarted[3].trim(),
      workflowName: stripInlineMarkdown(taskStarted[4]).trim(),
      executionId: taskStarted[5].trim(),
      selection,
      suffix: taskStarted[6] ?? null,
    });
  }

  const taskMovedOnly = remainder.match(
    /^Task\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\s+\("([^"]+)"\)\s+moved to\s+\*{0,2}([A-Za-z_]+)\*{0,2}\.$/i,
  );
  if (taskMovedOnly?.[1] && taskMovedOnly?.[2] && taskMovedOnly?.[3]) {
    return formatPresentedTaskStart({
      taskId: taskMovedOnly[1].trim(),
      title: taskMovedOnly[2].trim(),
      status: taskMovedOnly[3].trim(),
      selection,
    });
  }

  const taskAdded = text.match(
    /^Task\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\s+\("([^"]+)"\)\s+added to\s+\*{0,2}([A-Za-z_]+)\*{0,2}\.?$/i,
  );
  if (taskAdded) {
    return [
      "✅ Task added",
      "",
      `Title: ${taskAdded[2]}`,
      `Status: ${taskAdded[3]}`,
      `ID: ${taskAdded[1]}`,
    ].join("\n");
  }

  const taskMoved = text.match(
    /^Task\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\s+moved to\s+\*{0,2}([A-Za-z_]+)\*{0,2}\.?$/i,
  );
  if (taskMoved) {
    return [
      "✅ Task updated",
      "",
      `Status: ${taskMoved[2]}`,
      `ID: ${taskMoved[1]}`,
    ].join("\n");
  }

  const taskFromDocument = text.match(
    /^Task\s+\*{0,2}([A-Za-z0-9_-]+)\*{0,2}\s+created from (?:document|data source)\s+\*{0,2}(.+?)\*{0,2}\.?$/i,
  );
  if (taskFromDocument) {
    return [
      "📄 Task created from data source",
      "",
      `Data source: ${taskFromDocument[2]}`,
      `Task ID: ${taskFromDocument[1]}`,
    ].join("\n");
  }

  const configUpdated = text.match(/^Config updated:\s+([A-Za-z0-9_.-]+)\s*=\s*(.+)$/i);
  if (configUpdated) {
    return [
      "⚙️ Config updated",
      "",
      `Setting: ${configUpdated[1]}`,
      `Value: ${configUpdated[2]}`,
    ].join("\n");
  }

  const configValue = text.match(/^Config\s+([A-Za-z0-9_.-]+)\s*=\s*(.+)$/i);
  if (configValue) {
    return [
      "⚙️ Config",
      "",
      `Setting: ${configValue[1]}`,
      `Value: ${configValue[2]}`,
    ].join("\n");
  }

  if (text.startsWith("Documents (") || text.startsWith("Data Sources (")) {
    return `📚 ${text}`;
  }

  return normalizeWorkflowNarrative(text);
}

function renderMarkdownLike(text: string): string {
  return replaceLinks(text, (label, url) => `[${label}](${url})`)
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading?.[1]) {
        return `## ${decorateHeading(heading[1])}`;
      }
      if (line.trim() === "---") {
        return "────────";
      }
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderWebChat(text: string): string {
  return replaceLinks(text, (label, url) => `[${label}](${url})`)
    .split("\n")
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading?.[1] && heading[2]) {
        return `${heading[1]} ${decorateHeading(heading[2])}`;
      }
      if (line.trim() === "---") {
        return "---";
      }
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderWhatsApp(text: string): string {
  return replaceLinks(text, (label, url) => `${label}: ${url}`)
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading?.[1]) {
        return `*${decorateHeading(heading[1])}*`;
      }
      if (line.trim() === "---") {
        return "────────";
      }
      if (/^\*\*([^*]+)\*\*$/.test(line.trim())) {
        const content = line.trim().replace(/^\*\*|\*\*$/g, "");
        return `*${content}*`;
      }
      return line.replace(/\*\*([^*]+)\*\*/g, "*$1*");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPlainText(text: string): string {
  return replaceLinks(text, (label, url) => `${label}: ${url}`)
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading?.[1]) {
        return decorateHeading(heading[1]);
      }
      if (line.trim() === "---") {
        return "────────";
      }
      return stripInlineMarkdown(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── MEDIA:/path unified attachment syntax ─────────────────────────────────
// The model emits `MEDIA:/absolute/path/to/file` (or `MEDIA:https://...`) when it
// wants to deliver a file/image alongside the answer. Each channel rewrites
// the directive into its native attachment form:
//   - WebChat: rewrite known artifact paths (data/generated-images/*) to
//     `/api/generated-images?id=<basename>` markdown image links;
//     other paths surface as plain absolute-path notes.
//   - Telegram / Discord / Slack / Teams / WhatsApp / BlueBubbles: keep the
//     `MEDIA:/path` token in the rendered text so the channel adapter can
//     intercept it before sending and call the native attachment API.
//   - Plain text channels: keep the path as-is so the user can open it.
//
// Adapted from a per-platform presentation hint table in
// agent/prompt_builder.py:411-589 which describes the same syntax.
const MEDIA_TAG_RE = /MEDIA:(https?:\/\/\S+|\/(?:[^\s)<>'"]+))/g;
const GENERATED_IMAGES_MARKER = "/data/generated-images/";

function isGeneratedImageArtifact(target: string): string | null {
  const normalized = target.replace(/\\/g, "/");
  const markerIndex = normalized.indexOf(GENERATED_IMAGES_MARKER);
  const rest = markerIndex >= 0
    ? normalized.slice(markerIndex + GENERATED_IMAGES_MARKER.length)
    : normalized.startsWith("data/generated-images/")
      ? normalized.slice("data/generated-images/".length)
      : "";
  return rest.split("/")[0] || null;
}

function rewriteMediaForWebChat(text: string): string {
  return text.replace(MEDIA_TAG_RE, (_match, target: string) => {
    if (/^https?:\/\//i.test(target)) {
      // Remote URL — let WebChat render it as a plain image markdown.
      if (/\.(png|jpe?g|webp|gif|svg)$/i.test(target)) {
        return `![media](${target})`;
      }
      return `[media](${target})`;
    }
    const artifactId = isGeneratedImageArtifact(target);
    if (artifactId) {
      return `![generated](/api/generated-images?id=${encodeURIComponent(artifactId)})`;
    }
    // Local file path that we can't serve directly — surface as a note.
    return `📎 ${target}`;
  });
}

export function presentChannelResponse(channel: PresentationChannel, text: string): string {
  const normalized = rewriteStructuredResponses(normalizeText(text));
  if (!normalized) return "";

  if (channel === "webchat") {
    return renderWebChat(rewriteMediaForWebChat(normalized));
  }
  if (channel === "telegram" || channel === "discord" || channel === "slack" || channel === "teams") {
    // Leave MEDIA: tokens intact — the channel adapter intercepts them before send.
    return renderMarkdownLike(normalized);
  }
  if (channel === "whatsapp") {
    return renderWhatsApp(normalized);
  }
  return renderPlainText(normalized);
}

/**
 * Pull MEDIA:/path tokens out of an outgoing message so a channel adapter can
 * deliver them as native attachments. Returns the cleaned text and the list of
 * media targets in order.
 */
export function extractMediaAttachments(text: string): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  const cleaned = text.replace(MEDIA_TAG_RE, (_match, target: string) => {
    attachments.push(target);
    return "";
  });
  return { text: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), attachments };
}
