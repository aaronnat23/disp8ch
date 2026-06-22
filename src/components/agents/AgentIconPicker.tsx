"use client";

import { useState } from "react";
import {
  Bot, Cpu, Brain, Zap, Rocket, Code, Terminal,
  Shield, Eye, Search, Wrench, Hammer, Lightbulb,
  Sparkles, Star, Heart, Flame, Bug, Cog, Database,
  Globe, Lock, Mail, MessageSquare, FileCode, GitBranch,
  Package, Puzzle, Target, Wand, Atom, CircuitBoard,
  Swords, Telescope, Microscope, Crown, Gem,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  Bot, Cpu, Brain, Zap, Rocket, Code, Terminal,
  Shield, Eye, Search, Wrench, Hammer, Lightbulb,
  Sparkles, Star, Heart, Flame, Bug, Cog, Database,
  Globe, Lock, Mail, MessageSquare, FileCode, GitBranch,
  Package, Puzzle, Target, Wand, Atom, CircuitBoard,
  Swords, Telescope, Microscope, Crown, Gem,
};

export function AgentIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = Object.keys(ICON_MAP).filter((icon) =>
    icon.toLowerCase().includes(search.toLowerCase()),
  );

  const IconComponent = ICON_MAP[value] || Bot;

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-10 w-10 items-center justify-center rounded-md border bg-background hover:bg-muted"
        onClick={() => setOpen(!open)}
      >
        <IconComponent className="h-5 w-5" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border bg-popover p-2 shadow-lg">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search icons..."
              className="mb-2 w-full rounded border bg-background px-2 py-1 text-xs outline-none"
            />
            <div className="grid max-h-48 grid-cols-7 gap-1 overflow-auto">
              {filtered.map((icon) => {
                const TheIcon = ICON_MAP[icon] || Bot;
                return (
                  <button
                    key={icon}
                    type="button"
                    className={`flex h-8 w-8 items-center justify-center rounded hover:bg-muted ${
                      value === icon ? "bg-primary/10 ring-1 ring-primary" : ""
                    }`}
                    onClick={() => {
                      onChange(icon);
                      setOpen(false);
                    }}
                    title={icon}
                  >
                    <TheIcon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
