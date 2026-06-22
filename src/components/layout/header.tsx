"use client";

import { useState } from "react";
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
  const [user, setUser] = useState<User | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const router = useRouter();

  const openPalette = () => window.dispatchEvent(new CustomEvent("disp8ch:open-palette"));

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
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
        <Terminal className="h-3.5 w-3.5 text-terminal-red" />
        <span>SYS::READY</span>
      </div>

      {/* Command palette trigger */}
      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={openPalette}
          className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search or run a command...</span>
          <kbd className="hidden sm:inline rounded border bg-background px-1 py-0.5 text-[10px]">⌘K</kbd>
        </button>
      </div>

      <CommandPalette />

      {/* Right: controls */}
      <div className="flex items-center gap-3">
        <AttentionBell />
        <ThemeToggle />

        <Badge
          variant="outline"
          className={`gap-1.5 text-[10px] uppercase tracking-widest ${
            wsConnected
              ? "text-foreground border-terminal-red"
              : "text-muted-foreground border-border"
          }`}
        >
          {wsConnected ? (
            <>
              <span className="h-1.5 w-1.5 bg-terminal-red pulse-red" />
              LINK::UP
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 bg-muted-foreground" />
              LINK::DOWN
            </>
          )}
        </Badge>

        <DropdownMenu onOpenChange={(open) => { if (open) void loadUser(); }}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2 px-2 py-1 h-8 hover:bg-accent transition-all duration-200 lowercase">
                <div className="flex items-center gap-2">
                  {user?.image ? (
                    <img
                      src={user.image}
                      alt={user.name || user.email}
                      className="h-6 w-6 border border-border"
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
                    className="text-terminal-red focus:text-terminal-red focus:bg-primary/10 cursor-pointer py-2.5 px-3 flex items-center gap-2.5 uppercase text-xs tracking-wider"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span className="font-medium">SIGN OUT</span>
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
