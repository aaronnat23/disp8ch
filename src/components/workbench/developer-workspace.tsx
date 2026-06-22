"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TerminalSquare, FolderTree, MessageSquare } from "lucide-react";
import { getDesktopBridge } from "@/lib/client/desktop-bridge";

type Layout = "chat" | "operations" | "developer" | "focus";

const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "operations", label: "Operations" },
  { id: "developer", label: "Developer" },
  { id: "focus", label: "Focus" },
];

const STORAGE_KEY = "disp8ch:workbench-layout";

export function DeveloperWorkspace() {
  const [layout, setLayout] = useState<Layout>("developer");
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(getDesktopBridge() !== null);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) as Layout | null;
      if (stored) setLayout(stored);
    } catch {
      /* optional */
    }
  }, []);

  const choose = (next: Layout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* optional */
    }
  };

  const showFiles = layout !== "chat" && layout !== "focus";
  const showTerminal = layout === "developer";

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Developer Workspace</h1>
          <p className="text-xs text-muted-foreground">Optional terminal + files pane beside your work. Layout preference is saved locally.</p>
        </div>
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          {LAYOUTS.map((l) => (
            <Button
              key={l.id}
              variant={layout === l.id ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => choose(l.id)}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid flex-1 gap-3 lg:grid-cols-2">
        {showFiles ? (
          <Card className="flex min-h-[420px] flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
              <FolderTree className="h-3.5 w-3.5 text-terminal-red" /> Files
            </div>
            <iframe title="Files" src="/files" className="flex-1 border-0" />
          </Card>
        ) : (
          <Card className="flex min-h-[420px] items-center justify-center text-center">
            <div className="text-xs text-muted-foreground">
              <MessageSquare className="mx-auto mb-2 h-5 w-5" />
              Chat-focused layout. Switch to Developer or Operations to show panes.
            </div>
          </Card>
        )}

        {showTerminal ? (
          <Card className="flex min-h-[420px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
              <span className="flex items-center gap-2">
                <TerminalSquare className="h-3.5 w-3.5 text-terminal-red" /> Operator Terminal
              </span>
              <Badge variant="outline" className="text-[10px]">{isDesktop ? "desktop" : "browser"}</Badge>
            </div>
            <div className="flex flex-1 items-center justify-center p-6 text-center">
              <div className="max-w-sm space-y-2 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Embedded terminal</p>
                <p>
                  The operator terminal runs through the hardened desktop terminal module
                  (node-pty + xterm), bounded to trusted workspace roots and killed on window
                  close, runtime restart, update, and exit. Terminal output never enters model
                  context unless you explicitly attach it.
                </p>
                <p>
                  {isDesktop
                    ? "Enable the terminal module in your desktop build to activate this pane."
                    : "Open disp8ch in the desktop app to use the operator terminal."}
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="flex min-h-[420px] items-center justify-center text-center">
            <div className="text-xs text-muted-foreground">
              <TerminalSquare className="mx-auto mb-2 h-5 w-5" />
              Terminal hidden in this layout. Switch to Developer to show it.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
