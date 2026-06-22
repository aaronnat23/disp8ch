"use client";

import { useState, useEffect } from "react";
import { Download, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type ChatSessionListItem = {
  id: string;
  title: string;
  fastMode: boolean | null;
  channel?: string;
  senderLabel?: string;
  deliveryState?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
};

export function SessionSidebar({
  sessions,
  currentSession,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onExportChat,
  renamingSessionId,
  renameValue,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  className,
  forceVisible,
}: {
  sessions: ChatSessionListItem[];
  currentSession: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onExportChat: (format: "json" | "markdown") => void;
  renamingSessionId?: string | null;
  renameValue?: string;
  onRenameStart?: (id: string, title: string) => void;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  className?: string;
  forceVisible?: boolean;
}) {
  const [channelFilter, setChannelFilter] = useState("all");
  const [sessionSearch, setSessionSearch] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmingDeleteId) return;
    const timer = setTimeout(() => setConfirmingDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmingDeleteId]);

  const CHANNEL_SHORT: Record<string, string> = {
    webchat: "Web", telegram: "TG", discord: "DC", slack: "Slack",
    whatsapp: "WA", teams: "Teams", bluebubbles: "BB", "google-chat": "GC",
  };

  const filtered = (channelFilter === "all"
    ? sessions
    : sessions.filter(s => (s.channel || "webchat") === channelFilter))
    .filter(s => {
      if (!sessionSearch.trim()) return true;
      const q = sessionSearch.toLowerCase();
      return (s.title || "").toLowerCase().includes(q) ||
             (s.channel || "").toLowerCase().includes(q) ||
             (s.senderLabel || "").toLowerCase().includes(q);
    });
  return (
    <div
      className={cn(
        forceVisible ? "flex h-full w-full flex-col border-r bg-card" : "hidden w-[240px] flex-col border-r bg-card md:flex",
        className,
      )}
    >
      <div className="flex items-center justify-between p-3 border-b">
        <span className="text-sm font-semibold">Chats</span>
        <div className="flex items-center gap-1">
          {currentSession ? (
            <>
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => onExportChat("json")}
                title="Export chat as JSON"
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => onExportChat("markdown")}
                title="Export chat as Markdown"
              >
                <span className="text-[10px] font-bold leading-none">MD</span>
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCreateSession}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* Channel filter */}
      <div className="px-3 py-1.5 border-b">
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="h-7 w-full rounded-md border bg-background px-2 text-[11px] text-muted-foreground"
        >
          <option value="all">All channels</option>
          <option value="webchat">WebChat</option>
          <option value="telegram">Telegram</option>
          <option value="discord">Discord</option>
          <option value="slack">Slack</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="teams">Teams</option>
          <option value="bluebubbles">BlueBubbles</option>
          <option value="google-chat">Google Chat</option>
        </select>
      </div>
      <div className="px-3 py-1.5 border-b">
        <input
          type="text"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
          placeholder="Search sessions..."
          className="h-7 w-full rounded-md border bg-background px-2 text-[11px] text-muted-foreground"
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No sessions found
            </div>
          ) : (
            filtered.map((s) => (
            <div
              key={s.id}
              className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 overflow-hidden rounded-md px-2 py-1 text-sm transition-colors ${
                currentSession === s.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectSession(s.id)}
                className="flex min-w-0 items-center gap-2 text-left"
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {renamingSessionId === s.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => onRenameChange?.(e.target.value)}
                      onBlur={() => onRenameCommit?.()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.currentTarget.blur(); }
                        if (e.key === "Escape") { onRenameCancel?.(); }
                      }}
                      className="w-full bg-transparent text-sm outline-none border-b border-primary h-auto py-0"
                    />
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="block min-w-0 flex-1 truncate"
                        onDoubleClick={() => onRenameStart?.(s.id, s.title)}
                        title="Double-click to rename"
                      >
                        {s.title}
                      </span>
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px]">
                        {CHANNEL_SHORT[s.channel || "webchat"] || s.channel || "Web"}
                      </Badge>
                    </span>
                  )}
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {s.channel || "webchat"} · {s.senderLabel || "local operator"} · {s.messageCount ?? 0} msgs
                  </span>
                </span>
                {s.fastMode === true ? (
                  <Badge variant="outline" className="text-[10px]">
                    FAST
                  </Badge>
                ) : null}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border text-[10px] font-medium uppercase transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive",
                    confirmingDeleteId === s.id
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : "border-destructive/30 text-destructive hover:bg-destructive/10",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirmingDeleteId === s.id) {
                      onDeleteSession(s.id);
                      setConfirmingDeleteId(null);
                    } else {
                      setConfirmingDeleteId(s.id);
                    }
                  }}
                  aria-label={`Delete ${s.title}`}
                  title={confirmingDeleteId === s.id ? "Click again to confirm delete" : "Delete chat"}
                >
                  {confirmingDeleteId === s.id ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )))}
        </div>
      </ScrollArea>
    </div>
  );
}
