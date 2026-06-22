/**
 * Shared command registry for the desktop/web action palette, menus, and
 * shortcuts. This is the single source of palette commands so the Ctrl/Cmd+K
 * overlay, menus, and keybindings stay consistent (Phase 2). Pure + testable.
 */

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: string;
  href?: string;
  /** Non-navigation action handled by the palette host. */
  actionId?: string;
};

const NAV_COMMANDS: PaletteCommand[] = [
  { id: "nav.dashboard", title: "Dashboard", group: "Navigate", href: "/", keywords: "home overview operator" },
  { id: "nav.chat", title: "WebChat", group: "Navigate", href: "/chat", keywords: "ask assistant conversation prompt" },
  { id: "nav.workflows", title: "Workflows", group: "Navigate", href: "/workflows", keywords: "automation graph nodes n8n" },
  { id: "nav.boards", title: "Boards", group: "Navigate", href: "/boards", keywords: "tasks kanban cards" },
  { id: "nav.hierarchy", title: "Hierarchy", group: "Navigate", href: "/hierarchy", keywords: "goals org structure" },
  { id: "nav.council", title: "Council", group: "Navigate", href: "/council", keywords: "debate deliberation panel" },
  { id: "nav.agents", title: "Agents", group: "Navigate", href: "/agents", keywords: "model assistant configuration" },
  { id: "nav.scheduler", title: "Automations", group: "Navigate", href: "/scheduler", keywords: "cron webhooks schedule" },
  { id: "nav.skills", title: "Skills & Extensions", group: "Navigate", href: "/skills", keywords: "learning capabilities agent packs" },
  { id: "nav.mcp", title: "MCP Servers", group: "Navigate", href: "/mcp", keywords: "manage model context protocol tools resources approvals external servers" },
  { id: "nav.memory", title: "Memory", group: "Navigate", href: "/memory", keywords: "recall facts notes" },
  { id: "nav.designs", title: "Design Studio", group: "Navigate", href: "/designs", keywords: "design artifact layout" },
  { id: "nav.documents", title: "Documents", group: "Navigate", href: "/documents", keywords: "data sources files knowledge" },
  { id: "nav.research", title: "Research Team", group: "Navigate", href: "/hierarchy?panels=research", keywords: "scout analyst briefer research department" },
  { id: "nav.channels", title: "Channels", group: "Navigate", href: "/channels", keywords: "telegram discord slack" },
  { id: "nav.activity", title: "Activity", group: "Navigate", href: "/activity", keywords: "background jobs work monitor running" },
  { id: "nav.approvals", title: "Approvals", group: "Navigate", href: "/approvals", keywords: "governance review pending" },
  { id: "nav.maintenance", title: "Maintenance", group: "Navigate", href: "/maintenance", keywords: "doctor findings cleanup" },
  { id: "nav.usage", title: "Usage", group: "Navigate", href: "/usage", keywords: "cost tokens analytics" },
  { id: "nav.metrics", title: "Metrics", group: "Navigate", href: "/metrics", keywords: "stats observability" },
  { id: "nav.logs", title: "Logs", group: "Navigate", href: "/logs", keywords: "diagnostics output" },
  { id: "nav.files", title: "Files", group: "Navigate", href: "/files", keywords: "workspace editor" },
  { id: "nav.workbench", title: "Developer Workspace", group: "Navigate", href: "/workbench", keywords: "terminal files pane developer layout" },
  { id: "nav.settings", title: "Settings", group: "Navigate", href: "/settings", keywords: "preferences configuration providers" },
  { id: "nav.docs", title: "Docs", group: "Navigate", href: "/docs", keywords: "help onboarding guide" },
];

const ACTION_COMMANDS: PaletteCommand[] = [
  { id: "action.new-chat", title: "New chat session", group: "Actions", href: "/chat?new=1", keywords: "create start conversation" },
  { id: "action.shortcuts", title: "Edit keyboard shortcuts", group: "Actions", href: "/settings?tab=shortcuts", keywords: "keybindings rebind keys" },
  { id: "action.background-work", title: "Open Background Work", group: "Actions", href: "/activity", keywords: "work monitor jobs running agents" },
  { id: "action.attention", title: "Open Attention Center", group: "Actions", href: "/approvals", keywords: "notifications approvals alerts bell" },
  { id: "action.diagnostics", title: "Open diagnostics", group: "Actions", href: "/maintenance", keywords: "doctor health debug" },
  { id: "action.toggle-theme", title: "Toggle dark/light theme", group: "Actions", actionId: "toggle-theme", keywords: "appearance dark light" },
];

export function getStaticCommands(): PaletteCommand[] {
  return [...NAV_COMMANDS, ...ACTION_COMMANDS];
}

/** Case-insensitive token-AND match over title/group/keywords, ranked. */
export function filterCommands(commands: PaletteCommand[], query: string, limit = 12): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const tokens = q.split(/\s+/);
  const scored: Array<{ cmd: PaletteCommand; score: number }> = [];
  for (const cmd of commands) {
    const hay = `${cmd.title} ${cmd.group} ${cmd.keywords ?? ""}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    const title = cmd.title.toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    if (title.includes(q)) score += 40;
    score -= title.length * 0.1;
    scored.push({ cmd, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.cmd);
}
