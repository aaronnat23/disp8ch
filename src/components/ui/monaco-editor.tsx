"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

const MonacoEditorCore = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center border border-border bg-muted/30">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

interface MonacoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  height?: string | number;
  readOnly?: boolean;
  className?: string;
}

const THEME_STORAGE_KEY = "disp8ch-theme";
const THEME_EVENT_NAME = "disp8ch-theme-change";

function getEditorTheme(): "vs-dark" | "vs-light" {
  if (typeof window === "undefined") return "vs-dark";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" ? "vs-light" : "vs-dark";
}

export function MonacoEditor({
  value,
  onChange,
  language = "javascript",
  height = "200px",
  readOnly = false,
  className,
}: MonacoEditorProps) {
  const [theme, setTheme] = useState<"vs-dark" | "vs-light">("vs-dark");

  useEffect(() => {
    setTheme(getEditorTheme());

    const syncTheme = (raw?: string | null) => {
      if (raw === "light") {
        setTheme("vs-light");
        return;
      }
      if (raw === "dark") {
        setTheme("vs-dark");
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        syncTheme(event.newValue);
      }
    };

    const handleThemeEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      syncTheme(customEvent.detail);
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(THEME_EVENT_NAME, handleThemeEvent as EventListener);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(THEME_EVENT_NAME, handleThemeEvent as EventListener);
    };
  }, []);

  return (
    <div className={className} style={{ height }}>
      <MonacoEditorCore
        height="100%"
        language={language}
        value={value}
        onChange={(v) => onChange?.(v ?? "")}
        theme={theme}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          readOnly,
          padding: { top: 8, bottom: 8 },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
          renderLineHighlight: "line",
          contextmenu: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
