"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/layout/brand-logo";
import { useIdlePrefetch } from "@/lib/client/use-idle-prefetch";
import {
  Activity,
  BarChart3,
  Bug,
  Bot,
  Brain,
  CalendarClock,
  Layers3,
  ScrollText,
  LayoutDashboard,
  Link2,
  GitBranch,
  FileText,
  FolderOpen,
  KanbanSquare,
  MessageSquare,
  Settings,
  Server,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
  Wrench,
  Stethoscope,
  BookOpen,
  ChevronDown,
  Palette,
} from "lucide-react";

const navGroups = [
  {
    label: "Connect",
    items: [
      { href: "/chat", label: "WebChat", icon: MessageSquare },
      { href: "/channels", label: "Channels", icon: Link2 },
    ],
  },
  {
    label: "Build",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/workflows", label: "Workflows", icon: GitBranch },
      { href: "/boards", label: "Boards", icon: KanbanSquare },
      { href: "/documents", label: "Data Sources", icon: FileText },
      { href: "/designs", label: "Designs", icon: Palette },
      { href: "/scheduler", label: "Automations", icon: CalendarClock },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/hierarchy", label: "Hierarchy", icon: Layers3 },
      { href: "/council", label: "Council", icon: Users },
    ],
  },
  {
    label: "Capabilities",
    items: [
      { href: "/skills", label: "Skills & Extensions", icon: Wrench },
      { href: "/mcp", label: "MCP Servers", icon: Server },
      { href: "/memory", label: "Memory", icon: Brain },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/metrics", label: "Usage & Costs", icon: BarChart3 },
      { href: "/maintenance", label: "Maintenance", icon: Stethoscope },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/docs", label: "Help & Docs", icon: BookOpen },
    ],
  },
  {
    label: "More tools",
    advanced: true,
    items: [
      { href: "/usage", label: "Workflow Runs", icon: Sparkles },
      { href: "/approvals", label: "Approvals", icon: ShieldCheck },
      { href: "/files", label: "Files", icon: FolderOpen },
      { href: "/extensions", label: "Extension Sources", icon: Wrench },
      { href: "/tags", label: "Tags", icon: Tag },
      { href: "/logs", label: "Logs", icon: ScrollText },
      { href: "/debug", label: "Debug", icon: Bug },
    ],
  },
];

const ALL_PREFETCH = navGroups.flatMap((group) => group.items.map((item) => item.href));
const ADVANCED_ROUTES = new Set(
  navGroups.find((group) => group.advanced)?.items.map((item) => item.href) ?? [],
);

const ROUTE_TO_PERF_MARKER: Record<string, string> = {
  "/": "dashboard",
  "/chat": "chat",
  "/workflows": "workflows",
  "/boards": "boards",
  "/hierarchy": "hierarchy",
  "/council": "council",
  "/agents": "agents",
  "/activity": "activity",
  "/channels": "channels",
  "/documents": "documents",
  "/files": "files",
  "/designs": "designs",
  "/scheduler": "scheduler",
  "/approvals": "approvals",
  "/metrics": "metrics",
  "/usage": "usage",
  "/logs": "logs",
  "/debug": "debug",
  "/maintenance": "maintenance",
  "/settings": "settings",
  "/docs": "docs",
  "/tags": "tags",
  "/skills": "skills",
  "/mcp": "mcp",
  "/extensions": "extensions",
  "/memory": "memory",
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [moreToolsOpen, setMoreToolsOpen] = useState(() => ADVANCED_ROUTES.has(pathname));
  const allRoutes = useMemo(() => ALL_PREFETCH, []);

  useIdlePrefetch(allRoutes);

  const preloadTab = (href: string) => {
    const marker = ROUTE_TO_PERF_MARKER[href] ?? href.slice(1);
    window.dispatchEvent(new CustomEvent("disp8ch:preload-tab", { detail: { marker } }));
  };

  useEffect(() => {
    setPendingHref(null);
    if (ADVANCED_ROUTES.has(pathname)) setMoreToolsOpen(true);
  }, [pathname]);

  return (
    <aside className="hidden h-full w-[260px] flex-col border-r border-border bg-card md:flex">
      {/* ── Brand ── */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <BrandLogo className="h-16 w-16 shrink-0" priority />
        <span className="font-mono text-[1.7rem] font-bold leading-none tracking-normal">
          <span className="text-foreground">disp</span>
          <span className="text-terminal-red">8</span>
          <span className="text-foreground">ch</span>
        </span>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 space-y-4 overflow-auto px-2 py-3">
        {navGroups.map((group) => (
          <div key={group.label} className="space-y-0.5">
            {group.advanced ? (
              <button
                type="button"
                onClick={() => setMoreToolsOpen((open) => !open)}
                aria-expanded={moreToolsOpen}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:text-foreground"
              >
                <span className="text-terminal-red text-[10px] font-bold">{"// "}</span>
                <span className="data-label text-muted-foreground">{group.label}</span>
                <ChevronDown className={cn("ml-auto h-3 w-3 text-muted-foreground transition-transform", moreToolsOpen && "rotate-180")} />
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1">
                <span className="text-terminal-red text-[10px] font-bold">{"// "}</span>
                <span className="data-label text-muted-foreground">{group.label}</span>
              </div>
            )}
            {(!group.advanced || moreToolsOpen) && <div className="space-y-px">
              {group.items.map((item) => {
                const displayPath = pendingHref ?? pathname;
                const isActive =
                  item.href === "/"
                    ? displayPath === "/"
                    : displayPath.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onPointerEnter={() => {
                      router.prefetch(item.href);
                      preloadTab(item.href);
                    }}
                    onFocus={() => {
                      router.prefetch(item.href);
                      preloadTab(item.href);
                    }}
                    onClick={() => {
                      setPendingHref(item.href);
                      preloadTab(item.href);
                      window.sessionStorage.setItem("disp8ch:eager-tab-load", ROUTE_TO_PERF_MARKER[item.href] ?? item.href.slice(1));
                      window.dispatchEvent(new Event("disp8ch:navigation-start"));
                    }}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-3 px-3 py-2 text-xs font-medium transition-colors relative",
                      isActive
                        ? "bg-primary/10 text-terminal-red border-l-2 border-terminal-red"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent border-l-2 border-transparent"
                    )}
                  >
                    <item.icon className={cn("h-3.5 w-3.5", isActive && "text-terminal-red")} />
                    <span className="uppercase tracking-wider">{item.label}</span>
                    {isActive && (
                      <span className="ml-auto h-1.5 w-1.5 bg-terminal-red pulse-red" />
                    )}
                  </Link>
                );
              })}
            </div>}
          </div>
        ))}
      </nav>

      {/* ── Footer ── */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
          <span className="h-1.5 w-1.5 bg-terminal-red pulse-red" />
          <span className="uppercase tracking-widest">disp8ch v1.0.0</span>
        </div>
      </div>
    </aside>
  );
}
