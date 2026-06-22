"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { filterCommands, getStaticCommands, type PaletteCommand } from "@/lib/commands/registry";
import { comboFromEvent, loadBindings, normalizeKeys } from "@/lib/commands/shortcuts";

type SearchResult = { type: string; id: string; title: string; subtitle: string; href: string };

type Row =
  | { kind: "command"; key: string; cmd: PaletteCommand }
  | { kind: "search"; key: string; result: SearchResult };

function applyTheme() {
  try {
    const current = (localStorage.getItem("disp8ch-theme") as "dark" | "light") || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem("disp8ch-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    window.dispatchEvent(new CustomEvent("disp8ch-theme-change", { detail: next }));
  } catch {
    /* ignore */
  }
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => filterCommands(getStaticCommands(), query), [query]);

  const rows: Row[] = useMemo(() => {
    const commandRows: Row[] = commands.map((cmd) => ({ kind: "command", key: cmd.id, cmd }));
    const searchRows: Row[] = searchResults.map((result) => ({
      kind: "search",
      key: `${result.type}:${result.id}`,
      result,
    }));
    return [...commandRows, ...searchRows];
  }, [commands, searchResults]);

  // Open shortcut (respects rebound palette.open binding).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const bindings = loadBindings();
      const combo = comboFromEvent(e);
      if (combo && combo === normalizeKeys(bindings["palette.open"] || "mod+k")) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler, { capture: true });
    const openListener = () => setOpen(true);
    window.addEventListener("disp8ch:open-palette", openListener);
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("disp8ch:open-palette", openListener);
    };
  }, []);

  // Debounced object search.
  useEffect(() => {
    if (!open || !query.trim()) {
      setSearchResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        const json = await res.json();
        if (json.success) setSearchResults(json.data.results as SearchResult[]);
      } catch {
        setSearchResults([]);
      }
    }, 200);
  }, [open, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  const execute = useCallback(
    (row: Row) => {
      setOpen(false);
      setQuery("");
      if (row.kind === "search") {
        router.push(row.result.href);
        return;
      }
      const { cmd } = row;
      if (cmd.actionId === "toggle-theme") {
        applyTheme();
        return;
      }
      if (cmd.href) router.push(cmd.href);
    },
    [router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) execute(row);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-label="Command palette"
        className="fixed left-1/2 top-[14%] z-50 w-[min(92vw,560px)] -translate-x-1/2 rounded-lg border bg-card shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search workflows, agents, tasks…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="rounded border bg-background px-1 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-auto p-2">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No matches</div>
          ) : (
            rows.map((row, idx) => {
              const isActive = idx === active;
              const title = row.kind === "command" ? row.cmd.title : row.result.title;
              const subtitle = row.kind === "command" ? row.cmd.group : row.result.subtitle;
              const tag = row.kind === "command" ? row.cmd.group : row.result.type;
              return (
                <button
                  key={row.key}
                  data-row={idx}
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => execute(row)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isActive ? "bg-muted text-foreground" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{title}</div>
                    <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
                  </div>
                  {isActive ? (
                    <CornerDownLeft className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">{tag}</Badge>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
