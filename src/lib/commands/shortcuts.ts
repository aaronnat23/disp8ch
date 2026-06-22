/**
 * Rebindable keyboard shortcut model for the desktop/web shell (Phase 2).
 * Pure helpers: default bindings, key normalization, conflict detection, and a
 * small persistence layer over localStorage. `mod` represents Cmd on macOS and
 * Ctrl elsewhere, normalizing Windows/macOS modifiers.
 */

export type ShortcutBinding = {
  id: string;
  label: string;
  group: string;
  defaultKeys: string;
};

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { id: "palette.open", label: "Open command palette", group: "Global", defaultKeys: "mod+k" },
  { id: "chat.new", label: "New chat session", group: "Chat", defaultKeys: "mod+shift+n" },
  { id: "chat.switchSession", label: "Switch session", group: "Chat", defaultKeys: "mod+p" },
  { id: "nav.sidebar", label: "Toggle sidebar", group: "Navigation", defaultKeys: "mod+b" },
  { id: "nav.workbench", label: "Toggle developer workspace", group: "Navigation", defaultKeys: "mod+j" },
  { id: "nav.activity", label: "Open Background Work", group: "Navigation", defaultKeys: "mod+shift+a" },
  { id: "attention.open", label: "Open Attention Center", group: "Global", defaultKeys: "mod+shift+i" },
  { id: "model.picker", label: "Open model picker", group: "Chat", defaultKeys: "mod+m" },
];

const STORAGE_KEY = "disp8ch:shortcuts";

const MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"];

/** Normalize a key combination to a canonical, comparable string. */
export function normalizeKeys(input: string): string {
  if (!input) return "";
  const parts = input
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // `mod` is the primary accelerator (Cmd on macOS, Ctrl elsewhere). We never
      // distinguish ctrl from mod, so fold both to keep bindings comparable.
      if (p === "cmd" || p === "command" || p === "meta" || p === "super" || p === "win") return "mod";
      if (p === "control" || p === "ctrl") return "mod";
      if (p === "option" || p === "opt" || p === "alt") return "alt";
      if (p === "escape") return "esc";
      return p;
    });
  const mods = parts.filter((p) => MODIFIER_ORDER.includes(p));
  const keys = parts.filter((p) => !MODIFIER_ORDER.includes(p));
  const uniqueMods = [...new Set(mods)].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...uniqueMods, ...keys].join("+");
}

/** Build a normalized combo string from a KeyboardEvent-like object. */
export function comboFromEvent(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const key = (event.key || "").toLowerCase();
  if (key && !["meta", "control", "alt", "shift"].includes(key)) parts.push(key);
  return normalizeKeys(parts.join("+"));
}

/** Return conflicts: combos bound to more than one action. */
export function detectConflicts(bindings: Record<string, string>): Array<{ keys: string; ids: string[] }> {
  const byCombo = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(bindings)) {
    const combo = normalizeKeys(keys);
    if (!combo) continue;
    const list = byCombo.get(combo) ?? [];
    list.push(id);
    byCombo.set(combo, list);
  }
  return [...byCombo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([keys, ids]) => ({ keys, ids }));
}

export function defaultBindings(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const binding of DEFAULT_SHORTCUTS) map[binding.id] = binding.defaultKeys;
  return map;
}

export function loadBindings(): Record<string, string> {
  const base = defaultBindings();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Record<string, string>;
    return { ...base, ...stored };
  } catch {
    return base;
  }
}

export function saveBindings(bindings: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* localStorage optional */
  }
}
