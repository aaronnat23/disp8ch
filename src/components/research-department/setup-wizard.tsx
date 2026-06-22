"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Tier = "basic" | "standard" | "advanced";
type Channel = "webchat" | "telegram" | "slack" | "discord";

export interface CreatePayload {
  name: string;
  tier: Tier;
  focusArea: string;
  sources: { keywords: string[]; rssFeeds: string[]; arxivCategories: string[]; competitorUrls: string[] };
  delivery: { channel: Channel };
  vaultRoot?: string;
  allowCustomVaultPath?: boolean;
  safety: { maxSourcesPerRun: number; perRunTokenCap: number; analystMcpServer?: string | null };
}

const TIER_BLURB: Record<Tier, string> = {
  basic: "Scout + Briefer. Low-cost monitoring, no wiki.",
  standard: "Scout + Analyst + Briefer + markdown wiki. Recommended.",
  advanced: "Adds competitor diff, weekly synthesis, optional Analyst MCP, channel delivery.",
};

function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SetupWizard({
  onCancel,
  onCreate,
  busy,
}: {
  onCancel: () => void;
  onCreate: (payload: CreatePayload) => void;
  busy?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("AI Research Desk");
  const [tier, setTier] = useState<Tier>("standard");
  const [focusArea, setFocusArea] = useState("local-first AI agents and workflow automation");
  const [keywords, setKeywords] = useState("local agents, workflow automation");
  const [rss, setRss] = useState("https://hnrss.org/frontpage");
  const [arxiv, setArxiv] = useState("cs.AI");
  const [competitors, setCompetitors] = useState("");
  const [channel, setChannel] = useState<Channel>("webchat");
  const [vaultRoot, setVaultRoot] = useState("");
  const [allowCustom, setAllowCustom] = useState(false);
  const [maxSources, setMaxSources] = useState(25);
  const [mcpServer, setMcpServer] = useState("");

  const payload: CreatePayload = {
    name,
    tier,
    focusArea,
    sources: {
      keywords: splitLines(keywords),
      rssFeeds: splitLines(rss),
      arxivCategories: splitLines(arxiv),
      competitorUrls: splitLines(competitors),
    },
    delivery: { channel },
    vaultRoot: vaultRoot.trim() || undefined,
    allowCustomVaultPath: allowCustom,
    safety: { maxSourcesPerRun: maxSources, perRunTokenCap: 60000, analystMcpServer: mcpServer.trim() || null },
  };

  const steps = ["Tier", "Focus & Sources", "Delivery & Vault", "Safety & Review"];

  return (
    <div className="space-y-4 rounded-md border border-terminal-border bg-black/30 p-4">
      <div className="flex items-center gap-2 text-xs">
        {steps.map((s, i) => (
          <Badge key={s} variant={i === step ? "default" : "outline"}>
            {i + 1}. {s}
          </Badge>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-2">
          {(["basic", "standard", "advanced"] as Tier[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className={`block w-full rounded border p-3 text-left text-xs ${tier === t ? "border-terminal-red" : "border-terminal-border"}`}
            >
              <span className="font-semibold capitalize">{t}</span>
              <span className="ml-2 text-terminal-muted">{TIER_BLURB[t]}</span>
            </button>
          ))}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3 text-xs">
          <div>
            <Label htmlFor="research-team-name">Name</Label>
            <Input id="research-team-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="research-team-focus">Focus area / niche</Label>
            <Input id="research-team-focus" value={focusArea} onChange={(e) => setFocusArea(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="research-team-keywords">Keywords (comma or newline)</Label>
            <Textarea id="research-team-keywords" rows={2} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="research-team-rss">RSS feeds</Label>
            <Textarea id="research-team-rss" rows={2} value={rss} onChange={(e) => setRss(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="research-team-arxiv">arXiv categories / feed URLs</Label>
            <Input id="research-team-arxiv" value={arxiv} onChange={(e) => setArxiv(e.target.value)} />
          </div>
          {tier === "advanced" && (
            <div>
              <Label htmlFor="research-team-competitors">Competitor URLs (advanced)</Label>
              <Textarea id="research-team-competitors" rows={2} value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3 text-xs">
          <div>
            <Label htmlFor="research-team-channel">Delivery channel</Label>
            <select
              id="research-team-channel"
              className="mt-1 w-full rounded border border-terminal-border bg-black/40 p-2"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              <option value="webchat">WebChat (default)</option>
              <option value="telegram">Telegram</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
            </select>
            <p className="mt-1 text-terminal-muted">Non-WebChat channels deliver only if that channel is configured.</p>
          </div>
          <div>
            <Label htmlFor="research-team-vault">Vault path (optional)</Label>
            <Input id="research-team-vault" placeholder="default: data/workspace/research-department/<slug>" value={vaultRoot} onChange={(e) => setVaultRoot(e.target.value)} />
          </div>
          {vaultRoot.trim() && (
            <label className="flex items-center gap-2 text-terminal-muted">
              <input type="checkbox" checked={allowCustom} onChange={(e) => setAllowCustom(e.target.checked)} />
              I confirm this custom path outside the default workspace.
            </label>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3 text-xs">
          <div>
            <Label htmlFor="research-team-max-sources">Max sources per run</Label>
            <Input id="research-team-max-sources" type="number" value={maxSources} onChange={(e) => setMaxSources(Number(e.target.value) || 25)} />
          </div>
          {tier === "advanced" && (
            <div>
              <Label htmlFor="research-team-mcp">Analyst MCP server (optional, Analyst-only)</Label>
              <Input id="research-team-mcp" value={mcpServer} onChange={(e) => setMcpServer(e.target.value)} placeholder="mcp server name" />
            </div>
          )}
          <div className="rounded border border-terminal-border p-2 text-terminal-muted">
            <p className="font-semibold text-terminal-text">Review</p>
            <p>Tier: {tier}</p>
            <p>Agents: {tier === "basic" ? "Scout, Briefer" : "Scout, Analyst, Briefer"}</p>
            <p>Sources: {payload.sources.rssFeeds.length} RSS · {payload.sources.arxivCategories.length} arXiv · {payload.sources.competitorUrls.length} competitor</p>
            <p>Delivery: {channel}</p>
            <p>Vault: {vaultRoot.trim() || "default workspace path"}</p>
            <p>Safety: writes stay inside vault · no delete · max {maxSources} sources/run · empty inbox = 0 model calls</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="outline" size="sm" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < steps.length - 1 ? (
            <Button size="sm" onClick={() => setStep(step + 1)} disabled={busy}>
              Next
            </Button>
          ) : (
            <Button size="sm" onClick={() => onCreate(payload)} disabled={busy}>
              {busy ? "Creating…" : "Create Research Team"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
