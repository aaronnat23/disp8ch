"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { AttentionBell } from "@/components/layout/attention-bell";
import { CommandPalette } from "@/components/layout/command-palette";
import {
  LogOut,
  User as UserIcon,
  ChevronDown,
  Terminal,
  Search,
  Compass,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useExecutionStore } from "@/stores/execution-store";
import { useRouter } from "next/navigation";

type User = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

export function Header() {
  const wsConnected = useExecutionStore((s) => s.wsConnected);
  const [visibleWsConnected, setVisibleWsConnected] = useState(wsConnected);
  const [user, setUser] = useState<User | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const router = useRouter();

  const openPalette = () => window.dispatchEvent(new CustomEvent("disp8ch:open-palette"));

  useEffect(() => {
    if (wsConnected) {
      setVisibleWsConnected(true);
      return;
    }
    const timer = window.setTimeout(() => setVisibleWsConnected(false), 900);
    return () => window.clearTimeout(timer);
  }, [wsConnected]);

  const loadUser = async () => {
    if (userLoaded) return;
    setUserLoaded(true);
    fetch("/api/auth/me")
      .then(res => res.json())
      .then(json => {
        if (json.success) setUser(json.data);
      })
      .catch(() => setUser(null));
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-card px-4">
      {/* Left: system status line */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
        <Terminal className="h-3.5 w-3.5 text-terminal-red" />
        <span>ready</span>
      </div>

      {/* Command palette trigger */}
      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={openPalette}
          className="flex h-10 items-center gap-2 rounded-md border bg-muted/30 px-3 text-xs text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search or run a command...</span>
          <kbd className="hidden sm:inline rounded border bg-background px-1 py-0.5 text-[10px]">⌘K</kbd>
        </button>
      </div>

      <CommandPalette />

      {/* Right: controls */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-10 gap-2 md:flex transition-transform duration-150 ease-out active:scale-[0.96]"
          onClick={() => window.dispatchEvent(new CustomEvent("disp8ch:discover-more"))}
        >
          <Compass className="h-4 w-4" />
          Discover
        </Button>
        <AttentionBell />
        <ThemeToggle />

        <Badge
          variant="outline"
          className={`gap-1.5 text-[10px] font-mono ${
            visibleWsConnected
              ? "text-foreground border-terminal-red/50"
              : "text-muted-foreground border-border"
          }`}
        >
          {visibleWsConnected ? (
            <>
              <span className="h-1.5 w-1.5 bg-terminal-red pulse-red" />
              live
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 bg-muted-foreground" />
              offline
            </>
          )}
        </Badge>

        <DropdownMenu onOpenChange={(open) => { if (open) void loadUser(); }}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex h-10 items-center gap-2 px-2 hover:bg-accent transition-[background-color,color,scale] duration-150 ease-out lowercase active:scale-[0.96]">
                <div className="flex items-center gap-2">
                  {user?.image ? (
                    <img
                      src={user.image}
                      alt={user.name || user.email}
                      className="h-6 w-6 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                    />
                  ) : (
                    <div className="h-6 w-6 bg-primary/10 flex items-center justify-center border border-terminal-red/30">
                      <UserIcon className="h-3.5 w-3.5 text-terminal-red" />
                    </div>
                  )}
                  <div className="hidden sm:flex flex-col items-start leading-tight">
                    <span className="text-xs font-medium truncate max-w-[120px] normal-case">
                      {user ? user.name || user.email.split("@")[0] : "Operator"}
                    </span>
                  </div>
                  <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 mt-1">
              {user ? (
                <>
                  <DropdownMenuLabel className="flex flex-col py-2 px-3">
                    <span className="text-sm font-bold truncate">{user.name || "User"}</span>
                    <span className="text-xs text-muted-foreground truncate font-normal">{user.email}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleLogout}
                    className="text-terminal-red focus:text-terminal-red focus:bg-primary/10 cursor-pointer py-2.5 px-3 flex items-center gap-2.5 text-xs"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span className="font-medium">Sign out</span>
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuLabel className="flex flex-col py-2 px-3">
                  <span className="text-sm font-bold truncate">Operator</span>
                  <span className="text-xs text-muted-foreground truncate font-normal">
                    {userLoaded ? "No active session" : "Loading..."}
                  </span>
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
      </div>
    </header>
  );
}
