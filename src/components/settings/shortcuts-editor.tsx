"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_SHORTCUTS,
  comboFromEvent,
  defaultBindings,
  detectConflicts,
  loadBindings,
  normalizeKeys,
  saveBindings,
} from "@/lib/commands/shortcuts";

export function ShortcutsEditor() {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setBindings(loadBindings());
  }, []);

  const conflicts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of detectConflicts(bindings)) map.set(c.keys, c.ids);
    return map;
  }, [bindings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DEFAULT_SHORTCUTS;
    return DEFAULT_SHORTCUTS.filter((s) => `${s.label} ${s.group}`.toLowerCase().includes(q));
  }, [query]);

  const startRecording = (id: string) => setRecording(id);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      setBindings((prev) => {
        const next = { ...prev, [recording]: combo };
        saveBindings(next);
        return next;
      });
      setRecording(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [recording]);

  const reset = () => {
    const defaults = defaultBindings();
    setBindings(defaults);
    saveBindings(defaults);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Keyboard shortcuts</h3>
          <p className="text-xs text-muted-foreground">
            Click a shortcut to rebind it. Stored locally per device. <kbd className="rounded border px-1">mod</kbd> is Cmd on macOS and Ctrl elsewhere.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reset}>Reset to defaults</Button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter shortcuts…"
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none"
      />

      <div className="rounded-md border divide-y">
        {filtered.map((s) => {
          const keys = normalizeKeys(bindings[s.id] ?? s.defaultKeys);
          const inConflict = (conflicts.get(keys)?.length ?? 0) > 1;
          const isRecording = recording === s.id;
          return (
            <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm">{s.label}</div>
                <div className="text-[11px] text-muted-foreground">{s.group}</div>
              </div>
              <div className="flex items-center gap-2">
                {inConflict ? <Badge variant="destructive" className="text-[10px]">conflict</Badge> : null}
                <button
                  type="button"
                  onClick={() => startRecording(s.id)}
                  className={`min-w-24 rounded border px-2 py-1 font-mono text-xs ${
                    isRecording ? "border-terminal-red text-terminal-red animate-pulse" : "hover:bg-accent"
                  }`}
                >
                  {isRecording ? "Press keys…" : keys || "unset"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
