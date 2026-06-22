import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { PruningPolicy } from "./types";

type ToolArgs = Record<string, unknown> | null | undefined;

function shortArg(v: unknown, max = 80): string {
  if (v == null) return "";
  let s = typeof v === "string" ? v : JSON.stringify(v);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// Produce an informative one-line placeholder when an old tool result is pruned to
// free context. Uses both the tool args (what was attempted) and the result text
// (what came back) so later turns can see what was already done without paying the
// full token cost.
function summarizeToolResult(toolName: string, resultText: string, args?: ToolArgs): string {
  if (!resultText) {
    const argHint = args && Object.keys(args).length > 0 ? ` (${shortArg(args)})` : "";
    return `[${toolName}] no output${argHint}`;
  }

  const chars = resultText.length;
  const lineCount = (resultText.match(/\n/g) || []).length + (resultText.trim() ? 1 : 0);
  const a = (args ?? {}) as Record<string, unknown>;

  if (toolName === "read_file" || toolName === "memory_get") {
    const path = shortArg(a.path ?? a.file ?? a.id, 100) || "?";
    const offset = typeof a.offset === "number" ? `:${a.offset}` : "";
    const limit = typeof a.limit === "number" ? `(${a.limit} lines)` : "";
    return `[${toolName}] ${path}${offset} ${limit} — ${lineCount} lines, ${chars} chars`;
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    const path = shortArg(a.path ?? a.file, 100) || "?";
    return `[${toolName}] ${path} (${chars} chars result)`;
  }

  if (toolName === "search_files") {
    const pattern = shortArg(a.pattern ?? a.query ?? a.search, 60) || "?";
    const root = shortArg(a.path ?? a.root ?? a.directory ?? ".", 60);
    const matchCount = resultText.match(/"total_count"\s*:\s*(\d+)/)?.[1] ?? `${lineCount}`;
    return `[search_files] '${pattern}' in ${root} -> ${matchCount} matches`;
  }

  if (toolName === "list_files") {
    const root = shortArg(a.path ?? a.directory ?? ".", 80) || ".";
    return `[list_files] ${root} -> ${lineCount} entries (${chars} chars)`;
  }

  if (toolName === "find_files") {
    const pattern = shortArg(a.pattern ?? a.glob ?? a.name, 80) || "?";
    return `[find_files] ${pattern} -> ${lineCount} matches (${chars} chars)`;
  }

  if (toolName === "memory_search" || toolName === "session_recall" || toolName === "documents_search" || toolName === "documents_list") {
    const query = shortArg(a.query ?? a.q ?? a.scope, 80) || "?";
    return `[${toolName}] '${query}' -> ${lineCount} results (${chars} chars)`;
  }

  if (toolName === "memory_store") {
    const type = shortArg(a.type ?? a.kind ?? "note", 40);
    return `[memory_store] type=${type} stored (${chars} chars)`;
  }

  if (toolName === "bash_exec" || toolName === "run_shell") {
    const cmd = shortArg(a.command ?? a.cmd, 100) || "?";
    const exitMatch = resultText.match(/exit\s*(?:code)?\s*[:=]?\s*(-?\d+)/i);
    const exitCode = exitMatch?.[1] ?? (/error|fail|denied|not found/i.test(resultText.slice(0, 500)) ? "?(err)" : "?");
    return `[${toolName}] \`${cmd}\` -> exit ${exitCode}, ${lineCount} lines output`;
  }

  if (toolName === "run_code" || toolName === "run_python" || toolName === "run_python_script") {
    const codePreview = shortArg(a.code ?? a.script, 60) || "?";
    return `[${toolName}] \`${codePreview}\` (${lineCount} lines output)`;
  }

  if (toolName === "http_request" || toolName === "fetch_url") {
    const url = shortArg(a.url ?? a.endpoint, 100) || "?";
    const method = shortArg(a.method ?? "GET", 10);
    const statusMatch = resultText.match(/(?:^|\s)(\d{3})(?:\s|$)/);
    const status = statusMatch ? `${statusMatch[1]}` : "?";
    return `[${toolName}] ${method} ${url} -> ${status} (${chars} chars)`;
  }

  if (toolName === "web_search") {
    const query = shortArg(a.query ?? a.q, 80) || "?";
    return `[web_search] '${query}' -> ${chars} chars of results`;
  }

  if (toolName === "web_extract") {
    const urls = Array.isArray(a.urls) ? a.urls : a.url ? [a.url] : [];
    const first = shortArg(urls[0], 80) || "?";
    const extra = urls.length > 1 ? ` (+${urls.length - 1} more)` : "";
    return `[web_extract] ${first}${extra} (${chars} chars)`;
  }

  if (toolName === "web_crawl") {
    const root = shortArg(a.url ?? a.root, 80) || "?";
    return `[web_crawl] ${root} (${chars} chars)`;
  }

  if (toolName.startsWith("browser_")) {
    const url = shortArg(a.url ?? a.ref ?? a.target, 80);
    const detail = url ? ` ${url}` : "";
    return `[${toolName}]${detail} (${chars} chars)`;
  }

  if (toolName === "workflow_create" || toolName === "workflow_templates") {
    const name = shortArg(a.name ?? a.template, 60) || "?";
    return `[${toolName}] ${name} (${chars} chars)`;
  }

  if (toolName === "board_tasks" || toolName === "schedule_task") {
    const title = shortArg(a.title ?? a.task ?? a.action, 80) || "?";
    return `[${toolName}] ${title} (${chars} chars)`;
  }

  if (toolName === "image_generate") {
    const prompt = shortArg(a.prompt, 80) || "?";
    return `[image_generate] '${prompt}' (${chars} chars result)`;
  }

  if (toolName === "image_view") {
    const path = shortArg(a.path ?? a.url, 80) || "?";
    return `[image_view] ${path}`;
  }

  if (toolName === "clarify") {
    return "[clarify] asked user a question";
  }

  if (toolName === "send_message") {
    const target = shortArg(a.channel ?? a.target ?? a.sessionId, 60) || "?";
    return `[send_message] -> ${target} (${chars} chars)`;
  }

  // Generic fallback: include up to 2 args + size
  const argEntries = Object.entries(a).slice(0, 2);
  const argHint = argEntries.length > 0
    ? ` (${argEntries.map(([k, v]) => `${k}=${shortArg(v, 40)}`).join(", ")})`
    : "";
  const snippet = resultText.slice(0, 120).replace(/\n/g, " ");
  return `[${toolName}]${argHint} ${snippet}... (${chars} chars)`;
}

function trimToolText(text: string, policy: PruningPolicy): string {
  if (text.length <= policy.maxToolChars) return text;
  const head = text.slice(0, Math.max(0, policy.headChars));
  const tail = text.slice(Math.max(policy.headChars, text.length - policy.tailChars));
  return [
    head,
    "",
    "...",
    `[Tool result trimmed from ${text.length} chars to keep context lean]`,
    "...",
    "",
    tail,
  ].join("\n");
}

function buildPrunedToolResult(toolName: string, resultText: string, policy: PruningPolicy, args?: ToolArgs): string {
  const summary = summarizeToolResult(toolName, resultText, args);
  const trimmed = trimToolText(resultText, policy);
  return `${summary}\n\n${trimmed}`;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function findAnthropicProtectedStart(messages: Anthropic.MessageParam[], keepRecentAssistants: number): number {
  let seenAssistants = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    seenAssistants += 1;
    if (seenAssistants >= keepRecentAssistants) {
      return index;
    }
  }
  return 0;
}

function findOpenAIProtectedStart(
  messages: OpenAI.ChatCompletionMessageParam[],
  keepRecentAssistants: number,
): number {
  let seenAssistants = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string };
    if (message.role !== "assistant") continue;
    seenAssistants += 1;
    if (seenAssistants >= keepRecentAssistants) {
      return index;
    }
  }
  return 0;
}

function buildAnthropicToolNameMap(messages: Anthropic.MessageParam[], msgIndex: number): Map<string, { name: string; args: ToolArgs }> {
  const toolNameMap = new Map<string, { name: string; args: ToolArgs }>();
  if (msgIndex > 0) {
    const prev = messages[msgIndex - 1] as { role?: string; content?: unknown };
    if (prev.role === "assistant" && Array.isArray(prev.content)) {
      for (const block of prev.content) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "tool_use" && b.id && b.name) {
          toolNameMap.set(b.id, {
            name: b.name,
            args: (b.input && typeof b.input === "object") ? (b.input as Record<string, unknown>) : null,
          });
        }
      }
    }
  }
  return toolNameMap;
}

function getOpenAIToolMeta(
  messages: OpenAI.ChatCompletionMessageParam[],
  msgIndex: number,
  toolCallId: string,
): { name: string; args: ToolArgs } {
  if (msgIndex > 0) {
    const prev = messages[msgIndex - 1] as {
      role?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; name?: string; arguments?: string }>;
    };
    if (prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
      for (const tc of prev.tool_calls) {
        if (tc.id === toolCallId) {
          const name = tc.function?.name ?? tc.name ?? "unknown";
          const argRaw = tc.function?.arguments ?? tc.arguments;
          let args: ToolArgs = null;
          if (typeof argRaw === "string" && argRaw.trim()) {
            try { args = JSON.parse(argRaw) as Record<string, unknown>; } catch { /* leave null */ }
          }
          return { name, args };
        }
      }
    }
  }
  return { name: "unknown", args: null };
}

export function pruneAnthropicMessages(
  messages: Anthropic.MessageParam[],
  policy: PruningPolicy,
): { messages: Anthropic.MessageParam[]; pruned: boolean } {
  if (policy.mode === "off") return { messages, pruned: false };

  const protectedStart = findAnthropicProtectedStart(messages, policy.keepRecentAssistants);
  let pruned = false;

  const nextMessages = messages.map((message, index) => {
    if (index >= protectedStart || message.role !== "user" || !Array.isArray(message.content)) {
      return message;
    }

    const toolNameMap = buildAnthropicToolNameMap(messages, index);

    let changed = false;
    const nextContent = message.content.map((block) => {
      const current = block as { type: string; content?: unknown; tool_use_id?: string };
      if (current.type !== "tool_result") return block;

      const text = stringifyToolContent(current.content);
      if (text.length < policy.minToolChars) return block;

      changed = true;
      pruned = true;
      const meta = toolNameMap.get(current.tool_use_id || "") || { name: "unknown", args: null };
      return {
        ...current,
        content: buildPrunedToolResult(meta.name, text, policy, meta.args),
      } as Anthropic.ToolResultBlockParam;
    });

    return changed ? { ...message, content: nextContent } : message;
  });

  return { messages: nextMessages, pruned };
}

export function pruneOpenAIMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  policy: PruningPolicy,
): { messages: OpenAI.ChatCompletionMessageParam[]; pruned: boolean } {
  if (policy.mode === "off") return { messages, pruned: false };

  const protectedStart = findOpenAIProtectedStart(messages, policy.keepRecentAssistants);
  let pruned = false;

  const nextMessages = messages.map((message, index) => {
    const current = message as { role?: string; content?: unknown; tool_call_id?: string };
    if (index >= protectedStart || current.role !== "tool") return message;

    const text = stringifyToolContent(current.content);
    if (text.length < policy.minToolChars) return message;

    pruned = true;
    const meta = getOpenAIToolMeta(messages, index, current.tool_call_id || "");
    return {
      ...message,
      content: buildPrunedToolResult(meta.name, text, policy, meta.args),
    };
  });

  return { messages: nextMessages, pruned };
}
