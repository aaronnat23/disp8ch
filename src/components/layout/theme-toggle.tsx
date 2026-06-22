"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const THEME_STORAGE_KEY = "disp8ch-theme";
const THEME_EVENT_NAME = "disp8ch-theme-change";

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem(THEME_STORAGE_KEY) as Theme) || "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(getStoredTheme());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.dispatchEvent(new CustomEvent(THEME_EVENT_NAME, { detail: theme }));
  }, [mounted, theme]);

  useEffect(() => {
    const syncTheme = (nextTheme?: string | null) => {
      if (nextTheme === "dark" || nextTheme === "light") {
        setTheme(nextTheme);
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

  const toggle = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  return (
    <button
      onClick={toggle}
      className="group relative flex items-center gap-2 border border-border bg-transparent px-3 py-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground transition-all hover:border-terminal-red hover:text-terminal-red"
      title={`Switch to ${theme === "dark" ? "Light (Schematic)" : "Dark (Terminal)"} mode`}
    >
      {theme === "dark" ? (
        <>
          <Moon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">TERMINAL</span>
        </>
      ) : (
        <>
          <Sun className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">SCHEMATIC</span>
        </>
      )}
      <span className="absolute -bottom-px left-0 h-px w-0 bg-terminal-red transition-all group-hover:w-full" />
    </button>
  );
}
