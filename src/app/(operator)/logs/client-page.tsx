"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";

type UiLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type LogEntry = {
  raw: string;
  time: string | null;
  level: UiLogLevel | null;
  subsystem: string | null;
  message: string;
};

type LogsResponse = {
  file: string | null;
  fileName?: string | null;
  entries: LogEntry[];
  availableFiles: string[];
  truncated: boolean;
};

const LEVELS: UiLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const LOGS_UI_STATE_KEY = "disp8ch:logs-ui-state";

function formatTime(input: string | null): string {
  if (!input) return "";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return date.toLocaleTimeString();
}

export default function LogsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [autoFollow, setAutoFollow] = useState(true);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [levelFilters, setLevelFilters] = useState<Record<UiLogLevel, boolean>>({
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
  });

  const listRef = useRef<HTMLDivElement | null>(null);

  const loadLogs = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("limit", "1000");
      query.set("maxBytes", "2097152");
      if (selectedFile) query.set("file", selectedFile);
      const res = await fetch(`/api/logs?${query.toString()}`);
      const json = await res.json();
      if (!json.success) {
        setError(String(json.error || "Failed to load logs"));
        return;
      }

      const data = json.data as LogsResponse;
      setEntries(data.entries ?? []);
      setFile(data.file ?? null);
      setTruncated(Boolean(data.truncated));
      setAvailableFiles(data.availableFiles ?? []);

      if (!selectedFile && data.fileName) {
        setSelectedFile(data.fileName);
      } else if (selectedFile && data.availableFiles?.length && !data.availableFiles.includes(selectedFile)) {
        setSelectedFile(data.availableFiles[0] ?? "");
      }
    } catch (fetchError) {
      setError(String(fetchError));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [selectedFile]);

  // Defer /api/logs until useful-ready so the log viewer shell paints first.
  const logsLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (!logsLoadedOnceRef.current) return;
    void loadLogs();
  }, [loadLogs]);
  useAfterUseful(() => {
    logsLoadedOnceRef.current = true;
    void loadLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePolling(
    async () => { await loadLogs({ silent: true }); },
    [loadLogs],
    { intervalMs: 3000, enabled: autoFollow, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  useEffect(() => {
    if (!autoFollow) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoFollow, entries]);

  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return entries.filter((entry) => {
      if (entry.level && !levelFilters[entry.level]) return false;
      if (!needle) return true;
      const haystack = `${entry.message} ${entry.subsystem || ""} ${entry.raw}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, filterText, levelFilters]);

  const onToggleLevel = (level: UiLogLevel, checked: boolean) => {
    setLevelFilters((current) => ({ ...current, [level]: checked }));
  };

  const onExportVisible = () => {
    if (filtered.length === 0) return;
    const text = filtered.map((entry) => entry.raw).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `disp8ch-logs-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="logs">
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Logs</h1>
            <p className="text-sm text-muted-foreground">Live tail of gateway file logs.</p>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-xl">Gateway Logs</CardTitle>
                  <CardDescription>Filter by level, search text, and export visible rows.</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void loadLogs()} disabled={loading}>
                    {loading ? "Loading..." : "Refresh"}
                  </Button>
                  <Button variant="outline" onClick={onExportVisible} disabled={filtered.length === 0}>
                    Export visible
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[220px] flex-1">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Filter</div>
                  <Input
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    placeholder="Search logs"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={autoFollow}
                    onChange={(event) => setAutoFollow(event.target.checked)}
                  />
                  Auto-follow
                </label>
                <div className="min-w-[220px]">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">File</div>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={selectedFile}
                    onChange={(event) => setSelectedFile(event.target.value)}
                  >
                    {availableFiles.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {LEVELS.map((level) => (
                  <label
                    key={level}
                    className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={levelFilters[level]}
                      onChange={(event) => onToggleLevel(level, event.target.checked)}
                    />
                    <span>{level}</span>
                  </label>
                ))}
              </div>

              {file ? <p className="text-xs text-muted-foreground">File: {file}</p> : null}
              {truncated ? (
                <div className="rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                  Log output is truncated to the latest chunk.
                </div>
              ) : null}
              {error ? (
                <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div
                ref={listRef}
                className="max-h-[620px] overflow-auto rounded-md border bg-card/40"
                onScroll={(event) => {
                  const target = event.currentTarget;
                  const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
                  if (distanceFromBottom > 80 && autoFollow) {
                    setAutoFollow(false);
                  }
                }}
              >
                {loading && entries.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">Loading logs...</div>
                ) : filtered.length === 0 ? (
                  hideGettingStarted ? (
                    <div className="flex items-center justify-between gap-3 px-4 py-6">
                      <p className="text-sm text-muted-foreground">No log entries.</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setHideGettingStarted(false)}
                      >
                        Show Tips
                      </Button>
                    </div>
                  ) : (
                    <div className="px-4 py-6">
                      <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 p-4">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            Getting Started
                          </div>
                          <p className="mt-2 text-sm font-medium">Logs appear when the gateway writes file output.</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            If this stays empty, check that the runtime process is running and that your selected file and
                            level filters are not hiding entries.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setHideGettingStarted(true)}
                        >
                          Hide Tips
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="divide-y">
                    {filtered.map((entry, index) => (
                      <div
                        key={`${entry.time || "n/a"}-${entry.subsystem || "none"}-${index}`}
                        className="grid grid-cols-[90px_70px_180px_minmax(0,1fr)] gap-3 px-3 py-2 text-xs"
                      >
                        <div className="font-mono text-muted-foreground">{formatTime(entry.time)}</div>
                        <div>
                          <Badge variant="outline" className="h-5 text-[10px] uppercase">
                            {entry.level || "log"}
                          </Badge>
                        </div>
                        <div className="truncate font-mono text-muted-foreground">{entry.subsystem || "-"}</div>
                        <div className="font-mono leading-5">{entry.message || entry.raw}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </main>
  );
}
