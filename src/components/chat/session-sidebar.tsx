"use client";

import { useState, useEffect } from "react";
import { Clock3, Download, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ShapeAvatar } from "@/components/agents/shape-avatar";

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

export type ChatTeammateListItem = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  sessionId: string | null;
  unread: number;
  runningJobs: number;
  hasRoutine: boolean;
  lastMessage: { subject: string; preview: string; createdAt: string } | null;
};

function compactRelativeTime(value: string | null | undefined): string {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
  teammates = [],
  teammatesLoading = false,
  teammateError = null,
  onSelectTeammate,
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
  teammates?: ChatTeammateListItem[];
  teammatesLoading?: boolean;
  teammateError?: string | null;
  onSelectTeammate?: (agentId: string) => void;
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

  const teammateSessionIds = new Set(teammates.map((teammate) => teammate.sessionId).filter(Boolean));
  const filtered = (channelFilter === "all"
    ? sessions
    : sessions.filter(s => (s.channel || "webchat") === channelFilter))
    .filter((session) => !teammateSessionIds.has(session.id))
    .filter(s => {
      if (!sessionSearch.trim()) return true;
      const q = sessionSearch.toLowerCase();
      return (s.title || "").toLowerCase().includes(q) ||
             (s.channel || "").toLowerCase().includes(q) ||
             (s.senderLabel || "").toLowerCase().includes(q);
    });
  const filteredTeammates = (channelFilter === "all" || channelFilter === "webchat" ? teammates : [])
    .filter((teammate) => {
      if (!sessionSearch.trim()) return true;
      const query = sessionSearch.toLowerCase();
      return teammate.name.toLowerCase().includes(query) || Boolean(teammate.lastMessage?.preview.toLowerCase().includes(query));
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
                variant="ghost" size="icon" className="h-10 w-10"
                onClick={() => onExportChat("json")}
                title="Export chat as JSON"
                aria-label="Export chat as JSON"
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-10 w-10"
                onClick={() => onExportChat("markdown")}
                title="Export chat as Markdown"
                aria-label="Export chat as Markdown"
              >
                <span className="text-[10px] font-bold leading-none">MD</span>
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Start a new chat" onClick={onCreateSession}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* Channel filter */}
      <div className="px-3 py-1.5 border-b">
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="h-10 w-full rounded-md border bg-background px-2 text-[11px] text-muted-foreground"
          aria-label="Filter chats by channel"
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
          placeholder="Search chats and agents..."
          className="h-10 w-full rounded-md border bg-background px-2 text-[11px] text-muted-foreground"
          aria-label="Search chats and agents"
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-2">
          {filteredTeammates.length > 0 || teammatesLoading || teammateError ? (
            <section aria-labelledby="chat-agents-heading">
              <div className="flex h-7 items-center justify-between px-2">
                <span id="chat-agents-heading" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agents</span>
                {teammatesLoading ? <span className="text-[10px] text-muted-foreground">Refreshing…</span> : null}
              </div>
              <div className="space-y-1">
                {teammateError ? <p role="alert" className="rounded-md bg-destructive/10 px-2 py-2 text-[11px] text-destructive">{teammateError}</p> : null}
                {filteredTeammates.map((teammate) => (
                  <button
                    key={teammate.id}
                    type="button"
                    disabled={!teammate.isActive}
                    onClick={() => onSelectTeammate?.(teammate.id)}
                    className={cn(
                      "group flex min-h-12 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-[scale,background-color,box-shadow] duration-150 ease-out active:not-disabled:scale-[0.96] disabled:opacity-50",
                      currentSession && currentSession === teammate.sessionId
                        ? "bg-accent text-accent-foreground shadow-[0_0_0_1px_oklch(1_0_0/0.08)]"
                        : "text-muted-foreground hover:bg-accent/70",
                    )}
                  >
                    <span className="relative shrink-0">
                      <ShapeAvatar seed={teammate.id} size={34} />
                      <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card", teammate.runningJobs > 0 ? "bg-amber-400" : teammate.isActive ? "bg-emerald-400" : "bg-muted-foreground")} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{teammate.name}</span>
                        {teammate.unread > 0 ? <Badge className="h-5 min-w-5 justify-center px-1 text-[9px] tabular-nums">{teammate.unread}</Badge> : null}
                        <span className="text-[9px] tabular-nums text-muted-foreground">{compactRelativeTime(teammate.lastMessage?.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                        {teammate.hasRoutine ? <Clock3 className="h-3 w-3 shrink-0" /> : null}
                        <span className="truncate">{teammate.runningJobs > 0 ? `${teammate.runningJobs} task${teammate.runningJobs === 1 ? "" : "s"} running` : teammate.lastMessage?.preview || "Ready for a conversation"}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="recent-chats-heading">
            <div className="flex h-7 items-center px-2">
              <span id="recent-chats-heading" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent conversations</span>
            </div>
            <div className="space-y-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {filteredTeammates.length === 0 ? "No chats or agents found" : "No recent conversations"}
                </div>
              ) : filtered.map((s) => (
                <div
                  key={s.id}
                  className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 overflow-hidden rounded-md px-2 py-1 text-sm transition-colors ${currentSession === s.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >
                  {renamingSessionId === s.id ? (
                    <div className="flex min-h-10 min-w-0 items-center gap-2">
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => onRenameChange?.(e.target.value)}
                          onBlur={() => onRenameCommit?.()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") onRenameCancel?.();
                          }}
                          aria-label={`Rename ${s.title}`}
                          className="h-10 w-full border-b border-primary bg-transparent px-1 text-sm outline-none"
                        />
                        <span className="block truncate text-[10px] text-muted-foreground">{s.channel || "webchat"} · {s.senderLabel || "local operator"} · {s.messageCount ?? 0} msgs</span>
                      </span>
                    </div>
                  ) : (
                    <button type="button" onClick={() => onSelectSession(s.id)} className="flex min-h-10 min-w-0 items-center gap-2 text-left">
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="block min-w-0 flex-1 truncate" onDoubleClick={() => onRenameStart?.(s.id, s.title)} title="Double-click to rename">{s.title}</span>
                          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px]">{CHANNEL_SHORT[s.channel || "webchat"] || s.channel || "Web"}</Badge>
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">{s.channel || "webchat"} · {s.senderLabel || "local operator"} · {s.messageCount ?? 0} msgs</span>
                      </span>
                      {s.fastMode === true ? <Badge variant="outline" className="text-[10px]">FAST</Badge> : null}
                    </button>
                  )}
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[10px] font-medium uppercase transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive",
                      confirmingDeleteId === s.id ? "bg-destructive/10 text-destructive" : "text-destructive/70 hover:bg-destructive/10 hover:text-destructive",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (confirmingDeleteId === s.id) {
                        onDeleteSession(s.id);
                        setConfirmingDeleteId(null);
                      } else setConfirmingDeleteId(s.id);
                    }}
                    aria-label={`Delete ${s.title}`}
                    title={confirmingDeleteId === s.id ? "Click again to confirm delete" : "Delete chat"}
                  >
                    {confirmingDeleteId === s.id ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
