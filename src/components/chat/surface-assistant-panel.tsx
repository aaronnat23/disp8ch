"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, MessageSquareText, Send, Square } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type SurfaceChatMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

type SurfaceChatTurn = {
  clientTurnId: string;
  sessionId: string;
  status: string;
  message: string;
  response: string | null;
  error: string | null;
  streamContent: string;
  progressEvents?: Array<{ eventType: string; data: unknown; createdAt: string }>;
};

export type SurfaceAssistantCompletion = {
  sessionId: string;
  clientTurnId: string;
  response: string;
};

function latestProgressLabel(turn: SurfaceChatTurn | null): string | null {
  const data = turn?.progressEvents?.at(-1)?.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return String(record.label || record.event || record.status || "").trim() || null;
}

export function SurfaceAssistantPanel({
  sessionId,
  surfaceLabel,
  value,
  onValueChange,
  buildMessage,
  onCompleted,
  placeholder,
  disabled = false,
  contextLabel,
  contextDetail,
  controls,
  textareaId,
  returnTo,
  routingContext,
}: {
  sessionId: string;
  surfaceLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  buildMessage: (value: string) => string;
  onCompleted: (result: SurfaceAssistantCompletion) => void | Promise<void>;
  placeholder: string;
  disabled?: boolean;
  contextLabel?: string | null;
  contextDetail?: string | null;
  controls?: ReactNode;
  textareaId?: string;
  returnTo: string;
  routingContext?: string;
}) {
  const [messages, setMessages] = useState<SurfaceChatMessage[]>([]);
  const [activeTurn, setActiveTurn] = useState<SurfaceChatTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const handledTurns = useRef(new Set<string>());
  const historyRef = useRef<HTMLDivElement | null>(null);
  const activeTurnId = activeTurn?.clientTurnId ?? null;

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/channels?action=messages&sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const json = await response.json().catch(() => ({}));
      if (response.ok && json?.success && Array.isArray(json.data)) {
        setMessages(json.data as SurfaceChatMessage[]);
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [sessionId]);

  const loadTurns = useCallback(async (): Promise<SurfaceChatTurn[]> => {
    if (!sessionId) return [];
    const response = await fetch(`/api/channels?action=session-turns&sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    const json = await response.json().catch(() => ({}));
    return response.ok && json?.success && Array.isArray(json.data) ? json.data as SurfaceChatTurn[] : [];
  }, [sessionId]);

  useEffect(() => {
    setMessages([]);
    setActiveTurn(null);
    setError(null);
    if (!sessionId) return;
    void loadMessages();
    void loadTurns().then((turns) => {
      const running = turns.find((turn) => turn.status === "queued" || turn.status === "processing");
      if (running) setActiveTurn(running);
    });
  }, [loadMessages, loadTurns, sessionId]);

  useEffect(() => {
    if (!activeTurnId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const turns = await loadTurns();
        if (cancelled) return;
        const next = turns.find((turn) => turn.clientTurnId === activeTurnId);
        if (!next) {
          if (!cancelled) timer = setTimeout(poll, 1200);
          return;
        }
        setActiveTurn(next);
        if (["completed", "failed", "cancelled"].includes(next.status)) {
          await loadMessages();
          if (next.status === "completed" && !handledTurns.current.has(next.clientTurnId)) {
            handledTurns.current.add(next.clientTurnId);
            await onCompleted({
              sessionId,
              clientTurnId: next.clientTurnId,
              response: next.response || "",
            });
          }
          if (next.status === "failed") setError(next.error || "The assistant request failed.");
          if (next.status === "cancelled") setError("The assistant request was cancelled.");
          setActiveTurn(null);
          return;
        }
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : "Could not refresh assistant progress.");
      }
      if (!cancelled) timer = setTimeout(poll, 1200);
    };

    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTurnId, loadMessages, loadTurns, onCompleted, sessionId]);

  useEffect(() => {
    const element = historyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, activeTurn?.streamContent]);

  const send = useCallback(async () => {
    const displayMessage = value.trim();
    if (!displayMessage || disabled || activeTurn) return;
    setError(null);
    let routedMessage: string;
    try {
      routedMessage = buildMessage(displayMessage);
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : "Could not prepare the assistant request.");
      return;
    }
    const clientTurnId = `surface-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setMessages((current) => [
      ...current,
      {
        id: `optimistic-${clientTurnId}`,
        sessionId,
        role: "user",
        content: displayMessage,
        createdAt: new Date().toISOString(),
      },
    ]);
    setActiveTurn({
      clientTurnId,
      sessionId,
      status: "queued",
      message: displayMessage,
      response: null,
      error: null,
      streamContent: "",
    });
    onValueChange("");

    try {
      const response = await fetch("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "chat",
          sessionId,
          clientTurnId,
          message: routedMessage,
          displayMessage,
          routingMessage: routingContext ? `${routingContext}: ${displayMessage}` : displayMessage,
          async: true,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) {
        throw new Error(String(json?.error || `Assistant request failed with ${response.status}`));
      }
    } catch (sendError) {
      setActiveTurn(null);
      setError(sendError instanceof Error ? sendError.message : "Could not send the assistant request.");
      onValueChange(displayMessage);
      await loadMessages();
    }
  }, [activeTurn, buildMessage, disabled, loadMessages, onValueChange, routingContext, sessionId, value]);

  const cancel = useCallback(async () => {
    if (!activeTurn) return;
    await fetch("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel-turn", sessionId, clientTurnId: activeTurn.clientTurnId }),
    }).catch(() => {});
  }, [activeTurn, sessionId]);

  const visibleMessages = messages.filter((message) => message.role !== "system").slice(-8);
  const progressLabel = latestProgressLabel(activeTurn);
  const fullChatHref = `/chat?sessionId=${encodeURIComponent(sessionId)}&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div data-testid="surface-assistant-panel" className="rounded-2xl border border-border bg-background/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareText className="h-4 w-4 shrink-0 text-terminal-red" />
          <span className="truncate text-xs font-semibold">{surfaceLabel} assistant</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[9px]">Shared WebChat</Badge>
        </div>
        <a href={fullChatHref} className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
          Full chat <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div ref={historyRef} className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1" aria-live="polite">
        {historyLoading && visibleMessages.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading shared conversation
          </div>
        ) : visibleMessages.length === 0 ? (
          <p className="py-2 text-xs leading-5 text-muted-foreground">
            Describe a new design or ask for a change. This conversation remains available in WebChat.
          </p>
        ) : visibleMessages.map((message) => (
          <div
            key={message.id}
            className={`rounded-lg px-2.5 py-2 text-xs ${message.role === "user" ? "ml-6 bg-terminal-red/15" : "mr-2 bg-muted/60"}`}
          >
            {message.role === "assistant" ? <ChatMarkdown content={message.content} /> : <p className="whitespace-pre-wrap">{message.content}</p>}
          </div>
        ))}
        {activeTurn ? (
          <div className="mr-2 rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{progressLabel || (activeTurn.status === "queued" ? "Queued" : "Working on the design")}</span>
            </div>
            {activeTurn.streamContent ? <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{activeTurn.streamContent}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {contextLabel ? <Badge variant="secondary" className="max-w-full truncate text-[9px]">{contextLabel}</Badge> : null}
        {contextDetail ? <span className="truncate text-[10px] text-muted-foreground">{contextDetail}</span> : null}
      </div>

      {controls ? <div className="mt-2">{controls}</div> : null}

      <textarea
        id={textareaId}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        rows={3}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-2 w-full resize-none bg-transparent px-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />

      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">Enter to send, Shift+Enter for a new line</span>
        {activeTurn ? (
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void cancel()}>
            <Square className="mr-1 h-3 w-3" /> Stop
          </Button>
        ) : (
          <Button type="button" size="sm" className="h-7 px-2.5 text-[10px]" onClick={() => void send()} disabled={disabled || !value.trim()}>
            <Send className="mr-1 h-3 w-3" /> Send
          </Button>
        )}
      </div>
    </div>
  );
}
