export interface OperatorTab {
  id: string;
  href: string;
  label: string;
  bootstrapUrl?: string;
  readySelector: string;
  priority: number;
}

export const OPERATOR_TABS: readonly OperatorTab[] = [
  { id: "dashboard", href: "/", label: "Dashboard", bootstrapUrl: "/api/dashboard/bootstrap", readySelector: '[data-perf-ready="dashboard"]', priority: 1 },
  { id: "chat", href: "/chat", label: "WebChat", bootstrapUrl: "/api/chat/bootstrap", readySelector: '[data-perf-ready="chat"]', priority: 1 },
  { id: "workflows", href: "/workflows", label: "Workflows", bootstrapUrl: "/api/workflows/bootstrap", readySelector: '[data-perf-ready="workflows"]', priority: 3 },
  { id: "boards", href: "/boards", label: "Boards", bootstrapUrl: "/api/boards/bootstrap", readySelector: '[data-perf-ready="boards"]', priority: 3 },
  { id: "hierarchy", href: "/hierarchy", label: "Hierarchy", bootstrapUrl: "/api/hierarchy/bootstrap", readySelector: '[data-perf-ready="hierarchy"]', priority: 1 },
  { id: "council", href: "/council", label: "Council", bootstrapUrl: "/api/council/bootstrap", readySelector: '[data-perf-ready="council"]', priority: 4 },
  { id: "agents", href: "/agents", label: "Agents", bootstrapUrl: "/api/agents/bootstrap", readySelector: '[data-perf-ready="agents"]', priority: 3 },
  { id: "activity", href: "/activity", label: "Activity", bootstrapUrl: "/api/activity/bootstrap", readySelector: '[data-perf-ready="activity"]', priority: 4 },
  { id: "channels", href: "/channels", label: "Channels", bootstrapUrl: "/api/channels/bootstrap", readySelector: '[data-perf-ready="channels"]', priority: 5 },
  { id: "documents", href: "/documents", label: "Data Sources", bootstrapUrl: "/api/documents/bootstrap", readySelector: '[data-perf-ready="documents"]', priority: 5 },
  { id: "files", href: "/files", label: "Files", bootstrapUrl: "/api/files/bootstrap", readySelector: '[data-perf-ready="files"]', priority: 5 },
  { id: "designs", href: "/designs", label: "Designs", bootstrapUrl: "/api/design/bootstrap", readySelector: '[data-perf-ready="designs"]', priority: 5 },
  { id: "scheduler", href: "/scheduler", label: "Scheduler", bootstrapUrl: "/api/scheduler/bootstrap", readySelector: '[data-perf-ready="scheduler"]', priority: 5 },
  { id: "approvals", href: "/approvals", label: "Approvals", bootstrapUrl: "/api/approvals/bootstrap", readySelector: '[data-perf-ready="approvals"]', priority: 6 },
  { id: "metrics", href: "/metrics", label: "Metrics", bootstrapUrl: "/api/metrics/bootstrap", readySelector: '[data-perf-ready="metrics"]', priority: 6 },
  { id: "usage", href: "/usage", label: "Usage", bootstrapUrl: "/api/usage/bootstrap", readySelector: '[data-perf-ready="usage"]', priority: 6 },
  { id: "logs", href: "/logs", label: "Logs", bootstrapUrl: "/api/logs/bootstrap", readySelector: '[data-perf-ready="logs"]', priority: 6 },
  { id: "debug", href: "/debug", label: "Debug", bootstrapUrl: undefined, readySelector: '[data-perf-ready="debug"]', priority: 7 },
  { id: "maintenance", href: "/maintenance", label: "Maintenance", bootstrapUrl: "/api/maintenance/bootstrap", readySelector: '[data-perf-ready="maintenance"]', priority: 7 },
  { id: "settings", href: "/settings", label: "Settings", bootstrapUrl: "/api/settings/bootstrap", readySelector: '[data-perf-ready="settings"]', priority: 7 },
  { id: "docs", href: "/docs", label: "Docs", bootstrapUrl: undefined, readySelector: '[data-perf-ready="docs"]', priority: 6 },
  { id: "tags", href: "/tags", label: "Tags", bootstrapUrl: "/api/tags/bootstrap", readySelector: '[data-perf-ready="tags"]', priority: 7 },
  { id: "skills", href: "/skills", label: "Skills", bootstrapUrl: "/api/skills/bootstrap", readySelector: '[data-perf-ready="skills"]', priority: 6 },
  { id: "mcp", href: "/mcp", label: "MCP Servers", bootstrapUrl: "/api/mcp", readySelector: '[data-perf-ready="mcp"]', priority: 6 },
  { id: "extensions", href: "/extensions", label: "Extensions", bootstrapUrl: "/api/extensions/bootstrap", readySelector: '[data-perf-ready="extensions"]', priority: 6 },
  { id: "memory", href: "/memory", label: "Memory", bootstrapUrl: "/api/memory/bootstrap", readySelector: '[data-perf-ready="memory"]', priority: 6 },
];

export function getTabByHref(href: string): OperatorTab | undefined {
  return OPERATOR_TABS.find(t => t.href === href || (href === "/" && t.href === "/"));
}

export function getTabById(id: string): OperatorTab | undefined {
  return OPERATOR_TABS.find(t => t.id === id);
}

export const HOT_TABS = new Set(["dashboard", "chat", "hierarchy"]);
