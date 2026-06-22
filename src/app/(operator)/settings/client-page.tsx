"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ConfigSettingsDynamic,
  ModelSettingsDynamic,
  ChannelSettingsDynamic,
  VoiceSettingsDynamic,
  MemorySettingsDynamic,
  ToolsSettingsDynamic,
  GeneralSettingsDynamic,
  GoogleSettingsDynamic,
  SecretsSettingsDynamic,
  SecuritySettingsDynamic,
  ConfigValidationSettingsDynamic,
} from "@/app/settings/dynamic-panels";
import { ShortcutsEditor } from "@/components/settings/shortcuts-editor";

const SETTINGS_TABS = [
  { value: "config", label: "Config", group: "Runtime", keywords: "configuration app config defaults advanced raw presets reset" },
  { value: "models", label: "Models", group: "Models & Providers", keywords: "provider model api key openai anthropic gemini ollama runtime" },
  { value: "channels", label: "Channels", group: "Integrations", keywords: "telegram discord whatsapp slack teams google chat bluebubbles webchat" },
  { value: "voice", label: "Voice", group: "Integrations", keywords: "speech stt tts voice audio" },
  { value: "memory", label: "Memory", group: "Memory", keywords: "recall embedding index session search vector cleanup" },
  { value: "tools", label: "Tools", group: "Runtime", keywords: "custom tool bash wrappers execution approval" },
  { value: "general", label: "General", group: "Runtime", keywords: "learning backup telemetry hooks retry behavior" },
  { value: "google", label: "Google", group: "Integrations", keywords: "oauth gmail drive workspace" },
  { value: "secrets", label: "Secrets", group: "Security", keywords: "secret api keys encrypted credentials" },
  { value: "security", label: "Security", group: "Security", keywords: "audit posture policy origin webhook admin" },
  { value: "validate", label: "Validate", group: "Runtime", keywords: "doctor validation health config check" },
  { value: "shortcuts", label: "Shortcuts", group: "Runtime", keywords: "keyboard shortcuts keybindings rebind keys hotkeys palette" },
] as const;

const COMMON_TABS = ["models", "channels", "memory", "tools", "security", "shortcuts"];

const SETTINGS_TAB_HEALTH: Record<(typeof SETTINGS_TABS)[number]["value"], { status: string; dirty: string }> = {
  config: { status: "review", dirty: "editor tracks draft" },
  models: { status: "provider", dirty: "save required" },
  channels: { status: "integration", dirty: "save required" },
  voice: { status: "optional", dirty: "save required" },
  memory: { status: "indexed", dirty: "save required" },
  tools: { status: "runtime", dirty: "save required" },
  general: { status: "runtime", dirty: "save required" },
  google: { status: "oauth", dirty: "save required" },
  secrets: { status: "secure", dirty: "immediate" },
  security: { status: "audit", dirty: "read-only" },
  validate: { status: "doctor", dirty: "read-only" },
  shortcuts: { status: "local", dirty: "local only" },
};

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [activeTab, setActiveTab] = useState<(typeof SETTINGS_TABS)[number]["value"]>(() => {
    if (typeof window === "undefined") return "config";
    const tab = new URLSearchParams(window.location.search).get("tab");
    return SETTINGS_TABS.some((candidate) => candidate.value === tab)
      ? tab as (typeof SETTINGS_TABS)[number]["value"]
      : "config";
  });
  const [settingsView, setSettingsView] = useState<"common" | "advanced">("common");

  const requestedTab = searchParams.get("tab")
    ?? (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab"));
  const requestedAdvancedTab = SETTINGS_TABS.some((tab) => tab.value === requestedTab)
    && !COMMON_TABS.includes(requestedTab as (typeof COMMON_TABS)[number]);
  const isAdvanced = settingsView === "advanced" || requestedAdvancedTab;
  const allTabs = SETTINGS_TABS.map(t => ({ ...t }));
  const visibleTabs = isAdvanced ? allTabs : allTabs.filter(t => COMMON_TABS.includes(t.value));

  const matchingTabs = useMemo(() => {
    const query = settingsSearch.trim().toLowerCase();
    if (!query) return visibleTabs;
    return allTabs.filter((tab) =>
      `${tab.label} ${tab.group} ${tab.keywords}`.toLowerCase().includes(query),
    );
  }, [settingsSearch, visibleTabs, allTabs]);

  const advancedOnlyMatches = useMemo(() => {
    if (isAdvanced || !settingsSearch.trim()) return false;
    return matchingTabs.some((tab) => !COMMON_TABS.includes(tab.value));
  }, [isAdvanced, matchingTabs, settingsSearch]);

  useEffect(() => {
    setHydrated(true);
    try {
      const stored = window.localStorage.getItem("disp8ch-settings-view");
      if (stored === "common" || stored === "advanced") {
        setSettingsView(stored);
      }
    } catch {
      // localStorage is optional.
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem("disp8ch-settings-view", settingsView);
    } catch {
      // localStorage is optional.
    }
  }, [hydrated, settingsView]);

  useEffect(() => {
    if (SETTINGS_TABS.some((tab) => tab.value === requestedTab)) {
      // A deep link is an explicit navigation request. Reveal advanced-only
      // destinations instead of silently sending the operator back to Models.
      if (!COMMON_TABS.includes(requestedTab as (typeof COMMON_TABS)[number])) {
        setSettingsView("advanced");
      }
      setActiveTab(requestedTab as typeof activeTab);
    }
  }, [requestedTab]);

  useEffect(() => {
    if (matchingTabs.length === 0) return;
    if (matchingTabs.some((tab) => tab.value === activeTab)) return;
    setActiveTab(matchingTabs[0].value);
  }, [activeTab, matchingTabs]);

  useEffect(() => {
    if (!isAdvanced && !requestedAdvancedTab && !COMMON_TABS.includes(activeTab)) {
      setActiveTab(COMMON_TABS[0] as typeof activeTab);
    }
  }, [isAdvanced, activeTab, requestedAdvancedTab]);

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="settings">
          <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold">Settings</h1>
              <p className="text-sm text-muted-foreground">Search and edit runtime, provider, memory, integration, and security controls.</p>
            </div>
            <div className="w-full max-w-md space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">View:</span>
                <Button
	                  variant={settingsView === "common" ? "default" : "outline"}
	                  size="sm" className="h-7 text-xs"
	                  onClick={() => setSettingsView("common")}
                >
                  Common
                </Button>
                <Button
	                  variant={settingsView === "advanced" ? "default" : "outline"}
	                  size="sm" className="h-7 text-xs"
	                  onClick={() => setSettingsView("advanced")}
                >
                  Advanced
                </Button>
              </div>
              <Input
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
                placeholder="Search settings, providers, memory, security..."
              />
              <div className="flex flex-wrap gap-1">
                {Array.from(new Set(SETTINGS_TABS.map((tab) => tab.group))).map((group) => (
                  <Badge key={group} variant="outline" className="text-[10px]">{group}</Badge>
                ))}
              </div>
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
            <TabsList className="h-auto flex-wrap">
              {visibleTabs.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className={matchingTabs.some((match) => match.value === tab.value) ? "" : "hidden"}
                >
                  <span>{tab.label}</span>
                  <Badge variant="outline" className="ml-2 text-[9px]">
                    {SETTINGS_TAB_HEALTH[tab.value].status}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="mt-3 flex flex-wrap gap-1">
              {settingsSearch && matchingTabs.map((tab) => (
                <button
                  key={tab.value}
                  className="rounded-full border bg-background px-2.5 py-0.5 text-xs hover:bg-muted transition-colors"
                  onClick={() => setActiveTab(tab.value)}
                >
                  {tab.label}
                  <span className="ml-1 text-[10px] text-muted-foreground">· {SETTINGS_TAB_HEALTH[tab.value].status}</span>
                  {!COMMON_TABS.includes(tab.value) && (
                    <span className="ml-1 text-[10px] text-amber-500">advanced</span>
                  )}
                </button>
              ))}
            </div>
            {settingsSearch.trim() && matchingTabs.length === 0 ? (
              <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                No settings tabs match &ldquo;{settingsSearch.trim()}&rdquo;.
              </div>
            ) : null}
            {advancedOnlyMatches && settingsSearch.trim() ? (
              <div className="mt-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-muted-foreground">
                Some matching settings are in <span className="font-medium text-foreground">Advanced</span> view.{" "}
	                <button
	                  className="underline hover:text-foreground"
	                  onClick={() => setSettingsView("advanced")}
                >
                  Switch to see all settings.
                </button>
              </div>
            ) : null}

            <TabsContent value="config" className="space-y-4 mt-4">
              <ConfigSettingsDynamic />
            </TabsContent>

            <TabsContent value="models" className="space-y-4 mt-4">
              <ModelSettingsDynamic />
            </TabsContent>

            <TabsContent value="channels" className="space-y-4 mt-4">
              <ChannelSettingsDynamic />
            </TabsContent>

            <TabsContent value="voice" className="space-y-4 mt-4">
              <VoiceSettingsDynamic />
            </TabsContent>

            <TabsContent value="memory" className="space-y-4 mt-4">
              <MemorySettingsDynamic />
            </TabsContent>

            <TabsContent value="tools" className="space-y-4 mt-4">
              <ToolsSettingsDynamic />
            </TabsContent>

            <TabsContent value="general" className="space-y-4 mt-4">
              <GeneralSettingsDynamic />
            </TabsContent>

            <TabsContent value="google" className="space-y-4 mt-4">
              <GoogleSettingsDynamic />
            </TabsContent>

            <TabsContent value="secrets" className="space-y-4 mt-4">
              <SecretsSettingsDynamic />
            </TabsContent>

            <TabsContent value="security" className="space-y-4 mt-4">
              <SecuritySettingsDynamic />
            </TabsContent>

            <TabsContent value="validate" className="space-y-4 mt-4">
              <ConfigValidationSettingsDynamic />
            </TabsContent>

            <TabsContent value="shortcuts" className="space-y-4 mt-4">
              <ShortcutsEditor />
            </TabsContent>
          </Tabs>
        </main>
  );
}
