"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CircleOff,
  Loader2,
  MessageCircle,
  MessageSquare,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Unplug,
  Workflow,
  Send,
  Bot,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TelegramStatus = {
  connected: boolean;
  username: string;
};

type DiscordStatus = {
  connected: boolean;
  username: string;
};

type WhatsAppStatus = {
  connected: boolean;
  phoneNumber?: string;
  qr?: string;
};

type ChannelStatusPayload = {
  telegram: TelegramStatus;
  discord: DiscordStatus;
  whatsapp: WhatsAppStatus;
};

type ChannelAccessMode = "open" | "allowlist" | "pairing";

type ApprovedChannelSender = {
  channel: string;
  subjectKey: string;
  subjectLabel: string | null;
  approvedAt: string;
};

type PendingChannelPairing = {
  code: string;
  formattedCode: string;
  channel: string;
  subjectKey: string;
  subjectLabel: string | null;
  createdAt: string;
  expiresAt: string;
  ageMinutes: number;
  expiresInMinutes: number;
};

type ChannelAccessPayload = {
  mode: ChannelAccessMode;
  approved: ApprovedChannelSender[];
  pending: PendingChannelPairing[];
  limits: {
    ttlMinutes: number;
    maxPendingPerChannel: number;
  };
};

type CalloutState = {
  kind: "ok" | "error" | "info";
  text: string;
};

type DashboardTab = "overview" | "telegram" | "whatsapp" | "discord" | "playbook";
type ChannelFilter = "all" | "connected" | "needs-setup" | "pairing" | "disabled";

type ChannelsDashboardProps = {
  embedded?: boolean;
};

const EMPTY_STATUS: ChannelStatusPayload = {
  telegram: { connected: false, username: "" },
  discord: { connected: false, username: "" },
  whatsapp: { connected: false },
};

const EMPTY_ACCESS: ChannelAccessPayload = {
  mode: "open",
  approved: [],
  pending: [],
  limits: {
    ttlMinutes: 60,
    maxPendingPerChannel: 3,
  },
};

const CHANNELS_UI_STATE_KEY = "disp8ch:channels-ui-state";

const CHANNEL_SETUP_MATRIX = [
  {
    id: "webchat",
    label: "WebChat",
    kind: "built-in",
    trigger: "chat",
    setup: "Always available in /chat.",
    webhook: "local app route",
  },
  {
    id: "telegram",
    label: "Telegram",
    kind: "runtime",
    trigger: "telegram-trigger",
    setup: "BotFather token required.",
    webhook: "polling",
  },
  {
    id: "discord",
    label: "Discord",
    kind: "runtime",
    trigger: "discord-trigger",
    setup: "Bot token and message intent required.",
    webhook: "gateway",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    kind: "runtime",
    trigger: "message-trigger + whatsapp",
    setup: "QR link required.",
    webhook: "local session",
  },
  {
    id: "slack",
    label: "Slack",
    kind: "configured",
    trigger: "message-trigger + slack",
    setup: "Configure token/signing secret in Settings -> Channels.",
    webhook: "/api/channels/slack",
  },
  {
    id: "bluebubbles",
    label: "BlueBubbles",
    kind: "configured",
    trigger: "message-trigger + bluebubbles",
    setup: "Configure server URL and password in Settings -> Channels.",
    webhook: "/api/channels/bluebubbles",
  },
  {
    id: "teams",
    label: "Teams",
    kind: "configured",
    trigger: "message-trigger + teams",
    setup: "Configure Microsoft webhook/app credentials in Settings -> Channels.",
    webhook: "/api/channels/teams",
  },
  {
    id: "google-chat",
    label: "Google Chat",
    kind: "configured",
    trigger: "message-trigger + google-chat",
    setup: "Configure Google Chat app request URL.",
    webhook: "/api/channels/google-chat",
  },
] as const;

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <Badge className="gap-1 bg-emerald-500 text-white hover:bg-emerald-500">
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1">
      <CircleOff className="h-3 w-3" />
      Not Connected
    </Badge>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ChannelCallout({ state }: { state: CalloutState | null }) {
  if (!state) return null;

  const classes =
    state.kind === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : state.kind === "ok"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
        : "border-primary/40 bg-primary/10 text-primary";

  return <div className={`rounded-xl border px-3 py-2 text-sm ${classes}`}>{state.text}</div>;
}

export function ChannelsDashboard({ embedded = false }: ChannelsDashboardProps) {
  const [status, setStatus] = useState<ChannelStatusPayload>(EMPTY_STATUS);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [callouts, setCallouts] = useState<Record<string, CalloutState | null>>({});
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [accessControl, setAccessControl] = useState<ChannelAccessPayload>(EMPTY_ACCESS);
  const [manualAccessChannel, setManualAccessChannel] = useState("telegram");
  const [manualAccessSubjectKey, setManualAccessSubjectKey] = useState("");
  const [manualAccessSubjectLabel, setManualAccessSubjectLabel] = useState("");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const setBusyState = useCallback((key: string, value: boolean) => {
    setBusy((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setChannelCallout = useCallback((channel: string, next: CalloutState | null) => {
    setCallouts((prev) => ({ ...prev, [channel]: next }));
  }, []);

  const fetchStatuses = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) setBusyState("refresh", true);

      try {
        const res = await fetch("/api/channels?action=status", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.success || !data.data) {
          throw new Error(data.error || `Failed to load channel status (${res.status})`);
        }
        const nextStatus = {
          telegram: data.data.telegram ?? EMPTY_STATUS.telegram,
          discord: data.data.discord ?? EMPTY_STATUS.discord,
          whatsapp: data.data.whatsapp ?? EMPTY_STATUS.whatsapp,
        } as ChannelStatusPayload;
        setStatus(nextStatus);
        setLastRefresh(new Date().toISOString());
        return nextStatus;
      } catch (error) {
        if (!silent) {
          setChannelCallout("global", {
            kind: "error",
            text: `Status refresh failed: ${String(error)}`,
          });
        }
        return null;
      } finally {
        if (!silent) setBusyState("refresh", false);
      }
    },
    [setBusyState, setChannelCallout],
  );

  const callAction = useCallback(async (action: string, payload?: Record<string, unknown>) => {
    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Action '${action}' failed`);
    }
    return data.data;
  }, []);

  const fetchAccessControl = useCallback(async () => {
    try {
      const res = await fetch("/api/channels?action=access-control", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success || !data.data) {
        throw new Error(data.error || `Failed to load channel access control (${res.status})`);
      }
      setAccessControl(data.data as ChannelAccessPayload);
      return data.data as ChannelAccessPayload;
    } catch (error) {
      setChannelCallout("access", {
        kind: "error",
        text: `Channel access refresh failed: ${String(error)}`,
      });
      return null;
    }
  }, [setChannelCallout]);

  useAfterUseful(() => {
    void fetchStatuses();
    void fetchAccessControl();
  }, [fetchStatuses, fetchAccessControl]);

  usePolling(
    () => { void fetchStatuses({ silent: true }); },
    [fetchStatuses],
    { intervalMs: 15000, enabled: true, pauseWhenHidden: true, immediate: false },
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHANNELS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHANNELS_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  const connectedCount = useMemo(
    () => {
      let count = 1; // webchat is always on
      if (status.telegram.connected) count += 1;
      if (status.discord.connected) count += 1;
      if (status.whatsapp.connected) count += 1;
      // Slack, BlueBubbles, Teams, Google Chat are configured channels — check via channelRows
      return count;
    },
    [status],
  );
  const channelRows = useMemo(() => {
    const pendingChannels = new Set(accessControl.pending.map((entry) => entry.channel));
    return CHANNEL_SETUP_MATRIX.map((channel) => {
      const connected =
        channel.id === "webchat" ||
        (channel.id === "telegram" && status.telegram.connected) ||
        (channel.id === "discord" && status.discord.connected) ||
        (channel.id === "whatsapp" && status.whatsapp.connected);
      const pairingPending = pendingChannels.has(channel.id);
      const needsSetup = !connected && channel.kind !== "configured";
      const state = connected ? "connected" : pairingPending ? "pairing" : needsSetup ? "needs-setup" : "disabled";
      return { ...channel, connected, pairingPending, needsSetup, state };
    }).filter((channel) => {
      if (channelFilter === "all") return true;
      return channel.state === channelFilter;
    });
  }, [accessControl.pending, channelFilter, status.discord.connected, status.telegram.connected, status.whatsapp.connected]);

  const connectTelegram = async () => {
    if (!telegramToken.trim()) return;
    setBusyState("telegram-connect", true);
    setChannelCallout("telegram", null);
    try {
      const data = await callAction("connect-telegram", { token: telegramToken.trim() });
      setTelegramToken("");
      setChannelCallout("telegram", {
        kind: "ok",
        text: `Telegram connected as @${(data?.username as string | undefined) || "bot"}`,
      });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("telegram", { kind: "error", text: String(error) });
    } finally {
      setBusyState("telegram-connect", false);
    }
  };

  const disconnectTelegram = async () => {
    setBusyState("telegram-disconnect", true);
    setChannelCallout("telegram", null);
    try {
      await callAction("disconnect-telegram");
      setChannelCallout("telegram", { kind: "info", text: "Telegram disconnected." });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("telegram", { kind: "error", text: String(error) });
    } finally {
      setBusyState("telegram-disconnect", false);
    }
  };

  const connectDiscord = async () => {
    if (!discordToken.trim()) return;
    setBusyState("discord-connect", true);
    setChannelCallout("discord", null);
    try {
      const data = await callAction("connect-discord", { token: discordToken.trim() });
      setDiscordToken("");
      setChannelCallout("discord", {
        kind: "ok",
        text: `Discord connected as ${(data?.username as string | undefined) || "bot"}`,
      });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("discord", { kind: "error", text: String(error) });
    } finally {
      setBusyState("discord-connect", false);
    }
  };

  const disconnectDiscord = async () => {
    setBusyState("discord-disconnect", true);
    setChannelCallout("discord", null);
    try {
      await callAction("disconnect-discord");
      setChannelCallout("discord", { kind: "info", text: "Discord disconnected." });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("discord", { kind: "error", text: String(error) });
    } finally {
      setBusyState("discord-disconnect", false);
    }
  };

  const showWhatsAppQr = async () => {
    setBusyState("whatsapp-connect", true);
    setChannelCallout("whatsapp", null);
    try {
      await callAction("connect-whatsapp");
      setChannelCallout("whatsapp", {
        kind: "info",
        text: "QR session started. Scan with WhatsApp > Linked Devices.",
      });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("whatsapp", { kind: "error", text: String(error) });
    } finally {
      setBusyState("whatsapp-connect", false);
    }
  };

  const relinkWhatsApp = async () => {
    setBusyState("whatsapp-relink", true);
    setChannelCallout("whatsapp", null);
    try {
      await callAction("relink-whatsapp");
      setChannelCallout("whatsapp", {
        kind: "info",
        text: "WhatsApp auth reset. New QR generated for relink.",
      });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("whatsapp", { kind: "error", text: String(error) });
    } finally {
      setBusyState("whatsapp-relink", false);
    }
  };

  const logoutWhatsApp = async () => {
    setBusyState("whatsapp-disconnect", true);
    setChannelCallout("whatsapp", null);
    try {
      await callAction("disconnect-whatsapp");
      setChannelCallout("whatsapp", { kind: "info", text: "WhatsApp session logged out." });
      await fetchStatuses({ silent: true });
    } catch (error) {
      setChannelCallout("whatsapp", { kind: "error", text: String(error) });
    } finally {
      setBusyState("whatsapp-disconnect", false);
    }
  };

  const waitForScan = async () => {
    setBusyState("whatsapp-wait", true);
    setChannelCallout("whatsapp", {
      kind: "info",
      text: "Waiting up to 60s for WhatsApp to finish linking...",
    });

    try {
      let connected = false;
      for (let i = 0; i < 20; i += 1) {
        await sleep(3000);
        const next = await fetchStatuses({ silent: true });
        if (next?.whatsapp?.connected) {
          connected = true;
          break;
        }
      }

      if (connected) {
        setChannelCallout("whatsapp", {
          kind: "ok",
          text: "WhatsApp linked and connected.",
        });
      } else {
        setChannelCallout("whatsapp", {
          kind: "info",
          text: "Still waiting for scan. Keep this page open or click Refresh.",
        });
      }
    } finally {
      setBusyState("whatsapp-wait", false);
    }
  };

  const updateAccessOverview = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const record = payload as { overview?: ChannelAccessPayload };
    if (record.overview) {
      setAccessControl(record.overview);
      return;
    }
    setAccessControl(payload as ChannelAccessPayload);
  };

  const changeAccessMode = async (mode: ChannelAccessMode) => {
    setBusyState("access-mode", true);
    setChannelCallout("access", null);
    try {
      const data = await callAction("set-channel-access-mode", { mode });
      updateAccessOverview(data);
      setChannelCallout("access", {
        kind: "ok",
        text:
          mode === "open"
            ? "Channel access is open."
            : mode === "allowlist"
              ? "Channel access is now allowlist-only."
              : "Channel pairing mode is active for unapproved senders.",
      });
    } catch (error) {
      setChannelCallout("access", { kind: "error", text: String(error) });
    } finally {
      setBusyState("access-mode", false);
    }
  };

  const approveManualSender = async () => {
    const channel = manualAccessChannel.trim();
    const subjectKey = manualAccessSubjectKey.trim();
    if (!channel || !subjectKey) return;
    setBusyState("access-approve-manual", true);
    setChannelCallout("access", null);
    try {
      const data = await callAction("approve-channel-sender", {
        channel,
        subjectKey,
        subjectLabel: manualAccessSubjectLabel.trim() || null,
      });
      updateAccessOverview(data);
      setManualAccessSubjectKey("");
      setManualAccessSubjectLabel("");
      setChannelCallout("access", { kind: "ok", text: `Approved ${subjectKey} for ${channel}.` });
    } catch (error) {
      setChannelCallout("access", { kind: "error", text: String(error) });
    } finally {
      setBusyState("access-approve-manual", false);
    }
  };

  const approvePairing = async (code: string) => {
    setBusyState(`pairing-approve:${code}`, true);
    try {
      const data = await callAction("approve-channel-pairing", { code });
      updateAccessOverview(data);
      setChannelCallout("access", { kind: "ok", text: `Approved pairing code ${code}.` });
    } catch (error) {
      setChannelCallout("access", { kind: "error", text: String(error) });
    } finally {
      setBusyState(`pairing-approve:${code}`, false);
    }
  };

  const denyPairing = async (code: string) => {
    setBusyState(`pairing-deny:${code}`, true);
    try {
      const data = await callAction("deny-channel-pairing", { code });
      updateAccessOverview(data);
      setChannelCallout("access", { kind: "info", text: `Denied pairing code ${code}.` });
    } catch (error) {
      setChannelCallout("access", { kind: "error", text: String(error) });
    } finally {
      setBusyState(`pairing-deny:${code}`, false);
    }
  };

  const revokeApprovedSender = async (channel: string, subjectKey: string) => {
    setBusyState(`sender-revoke:${channel}:${subjectKey}`, true);
    try {
      const data = await callAction("revoke-channel-sender", { channel, subjectKey });
      updateAccessOverview(data);
      setChannelCallout("access", { kind: "info", text: `Revoked ${subjectKey} from ${channel}.` });
    } catch (error) {
      setChannelCallout("access", { kind: "error", text: String(error) });
    } finally {
      setBusyState(`sender-revoke:${channel}:${subjectKey}`, false);
    }
  };

  const runChannelDoctor = async () => {
    setBusyState("channel-doctor", true);
    setChannelCallout("global", null);
    try {
      await Promise.all([fetchStatuses({ silent: true }), fetchAccessControl()]);
      setChannelCallout("global", {
        kind: "ok",
        text: "Channel doctor refreshed runtime status and access control. For the full routed diagnosis, run `check channel health` in WebChat.",
      });
    } catch (error) {
      setChannelCallout("global", { kind: "error", text: `Channel doctor failed: ${String(error)}` });
    } finally {
      setBusyState("channel-doctor", false);
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
        <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-6">
          <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-cyan-500/10 blur-3xl" />
          <div className="pointer-events-none absolute -right-24 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Channel Control Center</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect messaging platforms, route events into workflows, and verify delivery paths from one place.
              </p>
            </div>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => void fetchStatuses()}
              disabled={Boolean(busy.refresh)}
            >
              {busy.refresh ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Refresh Status
            </Button>
            <Button
              variant="default"
              className="gap-2"
              onClick={() => void runChannelDoctor()}
              disabled={Boolean(busy["channel-doctor"])}
            >
              {busy["channel-doctor"] ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Run Channel Doctor
            </Button>
          </div>

          <div className="relative mt-5 grid gap-3 md:grid-cols-4">
            <StatChip label="Active Integrations" value={`${connectedCount}/8`} />
            <StatChip label="WebChat" value="Always On" />
            <StatChip
              label="Last Refresh"
              value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "Not yet"}
            />
            <StatChip label="Routing" value="Trigger-based" />
          </div>
        </section>
      )}

      <ChannelCallout state={callouts.global ?? null} />

      <div className="mb-4 rounded-md border bg-background p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">
            {connectedCount}/8 channels connected
          </span>
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${connectedCount === 8 ? "bg-emerald-500" : connectedCount > 0 ? "bg-amber-500" : "bg-muted-foreground"}`}
              style={{ width: `${(connectedCount / 8) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Getting Started panel (no channels connected) ── */}
      {connectedCount === 0 && (
        hideGettingStarted ? (
          <div className="mb-4 flex items-center justify-between gap-3 border border-dashed border-slate-700/60 bg-slate-900/30 px-4 py-3">
            <p className="text-sm text-slate-400">No external channels connected yet. WebChat remains available.</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(false)}>
              Show Tips
            </Button>
          </div>
        ) : (
          <div className="mb-4 border border-slate-600/60 bg-slate-800/40 p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED - CHANNELS</div>
                <p className="mt-2 text-sm text-slate-300 max-w-2xl">
                  Channels connect disp8ch AI to messaging platforms. Messages arrive through channels, get routed to workflows, and responses go back out. WebChat is always on; connect more below.
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(true)}>
                Hide Tips
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
              <div className="border border-slate-700/60 p-3 space-y-1">
                <div className="font-mono uppercase tracking-wide text-slate-400">WebChat (built-in)</div>
                <div className="text-slate-400">Go to <strong className="text-slate-300">/chat</strong> in the sidebar to start chatting immediately. No setup needed; WebChat is your default local channel.</div>
              </div>
              <div className="border border-slate-700/60 p-3 space-y-1">
                <div className="font-mono uppercase tracking-wide text-slate-400">Telegram / Discord</div>
                <div className="text-slate-400">Create a bot (<strong className="text-slate-300">@BotFather</strong> for Telegram, Discord Developer Portal for Discord), paste the token below, and click Connect.</div>
              </div>
              <div className="border border-slate-700/60 p-3 space-y-1">
                <div className="font-mono uppercase tracking-wide text-slate-400">Other Channels</div>
                <div className="text-slate-400">WhatsApp, Slack, Google Chat, BlueBubbles (iMessage), and Teams are also supported. Configure them in <strong className="text-slate-300">Settings - Channels</strong>.</div>
              </div>
            </div>
          </div>
        )
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DashboardTab)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 md:grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="discord">Discord</TabsTrigger>
          <TabsTrigger value="playbook">Test Playbook</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-3 border-primary/25 bg-gradient-to-r from-primary/10 via-card to-card">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <MessageSquare className="h-5 w-5 text-primary" />
                    Supported Channel Matrix
                  </CardTitle>
                  <CardDescription>
                    All channel routes are visible here, including configured webhook channels that do not have a live connect button on this page.
                  </CardDescription>
                </div>
                <select
                  value={channelFilter}
                  onChange={(event) => setChannelFilter(event.target.value as ChannelFilter)}
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="all">All channels</option>
                  <option value="connected">Connected</option>
                  <option value="needs-setup">Needs setup</option>
                  <option value="pairing">Pairing pending</option>
                  <option value="disabled">Configured/manual</option>
                </select>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {channelRows.map((channel) => (
                <div key={channel.id} className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">{channel.label}</div>
                      <div className="text-[11px] text-muted-foreground">{channel.trigger}</div>
                    </div>
                    <Badge
                      variant={
                        channel.state === "connected"
                          ? "default"
                          : channel.state === "pairing"
                            ? "secondary"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {channel.state}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div>Token/env: {channel.kind === "built-in" ? "not required" : channel.kind === "runtime" ? (channel.connected ? "validated" : "required") : "Settings managed"}</div>
                    <div>Setup: {channel.setup}</div>
                    <div>Webhook: <code>{channel.webhook}</code></div>
                    <div>Pairing: {channel.pairingPending ? "pending approval" : "none pending"}</div>
                    <div>Access: {accessControl.mode}</div>
                    <div>Last activity: not tracked in UI yet</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-cyan-400/20 bg-gradient-to-b from-cyan-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Send className="h-5 w-5 text-cyan-300" />
                  Telegram
                </CardTitle>
                <StatusBadge connected={status.telegram.connected} />
              </div>
              <CardDescription>Best channel for workflow command/testing loops.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatChip label="Bot" value={status.telegram.username ? `@${status.telegram.username}` : "Not linked"} />
              <Button variant="outline" className="w-full gap-2" onClick={() => setActiveTab("telegram")}>
                Open Telegram Setup
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card className="border-emerald-400/20 bg-gradient-to-b from-emerald-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <MessageCircle className="h-5 w-5 text-emerald-300" />
                  WhatsApp
                </CardTitle>
                <StatusBadge connected={status.whatsapp.connected} />
              </div>
              <CardDescription>QR-based linking for mobile-first handoff flows.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatChip label="Phone" value={status.whatsapp.phoneNumber || "Pending"} />
              <Button variant="outline" className="w-full gap-2" onClick={() => setActiveTab("whatsapp")}>
                Open WhatsApp Setup
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card className="border-violet-400/20 bg-gradient-to-b from-violet-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Bot className="h-5 w-5 text-violet-300" />
                  Discord
                </CardTitle>
                <StatusBadge connected={status.discord.connected} />
              </div>
              <CardDescription>Server-based channel for team workflows and alerts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatChip label="Bot" value={status.discord.username || "Not linked"} />
              <Button variant="outline" className="w-full gap-2" onClick={() => setActiveTab("discord")}>
                Open Discord Setup
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card className="lg:col-span-3 border-primary/25 bg-gradient-to-r from-primary/10 via-card to-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Workflow className="h-5 w-5 text-primary" />
                Workflow Routing Notes
              </CardTitle>
              <CardDescription>
                Telegram and Discord use dedicated trigger nodes. WhatsApp and Google Chat use <code>message-trigger</code> with explicit channel values.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-4">
              <StatChip label="Telegram Trigger" value="telegram-trigger" />
              <StatChip label="Discord Trigger" value="discord-trigger" />
              <StatChip label="WhatsApp Trigger" value="message-trigger + whatsapp" />
              <StatChip label="Google Chat Trigger" value="message-trigger + google-chat" />
            </CardContent>
          </Card>

          <Card className="lg:col-span-3 border-amber-400/20 bg-gradient-to-b from-amber-500/10 to-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-amber-300" />
                Channel Access Control
              </CardTitle>
              <CardDescription>
                Controls who can use connected messaging channels. This is separate from the Security tab, which audits posture; here you approve or block real sender identities.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <StatChip label="Mode" value={accessControl.mode} />
                <StatChip label="Approved Senders" value={String(accessControl.approved.length)} />
                <StatChip label="Pending Pairings" value={String(accessControl.pending.length)} />
                <StatChip label="Pairing TTL" value={`${accessControl.limits.ttlMinutes} min`} />
              </div>

              <ChannelCallout state={callouts.access ?? null} />

              <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
                  <div className="text-sm font-semibold">Mode</div>
                  <select
                    value={accessControl.mode}
                    onChange={(event) => void changeAccessMode(event.target.value as ChannelAccessMode)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    disabled={Boolean(busy["access-mode"])}
                  >
                    <option value="open">open</option>
                    <option value="allowlist">allowlist</option>
                    <option value="pairing">pairing</option>
                  </select>
                  <div className="text-xs text-muted-foreground">
                    {accessControl.mode === "open"
                      ? "Anyone reaching a connected channel can talk to the bot."
                      : accessControl.mode === "allowlist"
                        ? "Only approved sender IDs can use connected channels."
                        : "Unknown senders receive a one-time pairing code instead of reaching workflows."}
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
                  <div className="text-sm font-semibold">Manual Approval</div>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <select
                      value={manualAccessChannel}
                      onChange={(event) => setManualAccessChannel(event.target.value)}
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="telegram">telegram</option>
                      <option value="discord">discord</option>
                      <option value="whatsapp">whatsapp</option>
                      <option value="slack">slack</option>
                      <option value="bluebubbles">bluebubbles</option>
                      <option value="teams">teams</option>
                      <option value="google-chat">google-chat</option>
                    </select>
                    <Input
                      value={manualAccessSubjectKey}
                      onChange={(event) => setManualAccessSubjectKey(event.target.value)}
                      placeholder="Stable sender ID"
                    />
                    <Input
                      value={manualAccessSubjectLabel}
                      onChange={(event) => setManualAccessSubjectLabel(event.target.value)}
                      placeholder="Optional label"
                    />
                    <Button
                      onClick={() => void approveManualSender()}
                      disabled={Boolean(busy["access-approve-manual"]) || !manualAccessSubjectKey.trim()}
                    >
                      {busy["access-approve-manual"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Approve
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Use this when you already know the stable sender ID. Pairing mode can capture unknown senders automatically.
                  </div>
                </div>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold">Pending Pairings</div>
                    <Badge variant="outline">Max {accessControl.limits.maxPendingPerChannel} / channel</Badge>
                  </div>
                  {accessControl.pending.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No pending pairing requests.</div>
                  ) : (
                    <div className="space-y-2">
                      {accessControl.pending.map((entry) => (
                        <div key={entry.code} className="rounded-xl border border-border/50 bg-background/60 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="font-mono text-sm font-semibold">{entry.formattedCode}</div>
                              <div className="text-xs text-muted-foreground">
                                {entry.channel} · {entry.subjectLabel || entry.subjectKey}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {entry.subjectKey} · expires in {entry.expiresInMinutes} min
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => void approvePairing(entry.code)}
                                disabled={Boolean(busy[`pairing-approve:${entry.code}`])}
                              >
                                {busy[`pairing-approve:${entry.code}`] ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void denyPairing(entry.code)}
                                disabled={Boolean(busy[`pairing-deny:${entry.code}`])}
                              >
                                {busy[`pairing-deny:${entry.code}`] ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                                Deny
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
                  <div className="text-sm font-semibold">Approved Senders</div>
                  {accessControl.approved.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No approved sender IDs yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {accessControl.approved.slice(0, 12).map((entry) => (
                        <div key={`${entry.channel}:${entry.subjectKey}`} className="rounded-xl border border-border/50 bg-background/60 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold">{entry.subjectLabel || entry.subjectKey}</div>
                              <div className="text-xs text-muted-foreground">
                                {entry.channel} · {entry.subjectKey}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                Approved {new Date(entry.approvedAt).toLocaleString()}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void revokeApprovedSender(entry.channel, entry.subjectKey)}
                              disabled={Boolean(busy[`sender-revoke:${entry.channel}:${entry.subjectKey}`])}
                            >
                              {busy[`sender-revoke:${entry.channel}:${entry.subjectKey}`] ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                              Revoke
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="telegram" className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card className="border-cyan-400/25 bg-gradient-to-b from-cyan-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Telegram Bot Connection</CardTitle>
                <StatusBadge connected={status.telegram.connected} />
              </div>
              <CardDescription>Connect your BotFather token, then test with a Telegram trigger workflow.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <StatChip label="Mode" value="Polling" />
                <StatChip label="Bot Username" value={status.telegram.username ? `@${status.telegram.username}` : "n/a"} />
              </div>

              <ChannelCallout state={callouts.telegram ?? null} />

              {!status.telegram.connected ? (
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={telegramToken}
                    onChange={(event) => setTelegramToken(event.target.value)}
                    placeholder="Paste BotFather token"
                  />
                  <p className="text-xs text-muted-foreground">
                    Token is submitted for validation and should be stored through environment/secrets, not workflow JSON or code.
                  </p>
                  <Button
                    className="w-full"
                    onClick={() => void connectTelegram()}
                    disabled={Boolean(busy["telegram-connect"]) || !telegramToken.trim()}
                  >
                    {busy["telegram-connect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Connect Telegram Bot
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => void disconnectTelegram()}
                  disabled={Boolean(busy["telegram-disconnect"])}
                >
                  {busy["telegram-disconnect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
                  Disconnect Telegram Bot
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Telegram E2E Test Path</CardTitle>
              <CardDescription>Use this exact path to verify workflow + board task + channel response.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                1. Create template: <strong>Channel Board Assistant (Task Intake + List)</strong> from Workflows.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                2. Activate workflow and ensure board <code>main-board</code> exists.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                3. Send message examples:
                <br />
                <code>Task: research best RAG stack 2026</code>
                <br />
                <code>list tasks</code>
                <br />
                <code>run task &lt;taskId&gt;</code>
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                4. Verify a board task appears in <code>inbox</code> and your originating channel receives the reply.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                5. If multiple workflows are active, target one by name:
                <br />
                <code>run workflow: Channel Board Assistant v2 :: list tasks</code>
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
                Telegram routing in this app auto-sends the final workflow response back to the same chat.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="whatsapp" className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card className="border-emerald-400/25 bg-gradient-to-b from-emerald-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">WhatsApp Session</CardTitle>
                <StatusBadge connected={status.whatsapp.connected} />
              </div>
              <CardDescription>Link your phone once, then route incoming messages into workflows.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <StatChip label="Linked" value={status.whatsapp.connected ? "Yes" : "No"} />
                <StatChip label="Phone" value={status.whatsapp.phoneNumber || "n/a"} />
              </div>

              <ChannelCallout state={callouts.whatsapp ?? null} />

              {status.whatsapp.qr && !status.whatsapp.connected ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-200">
                    <QrCode className="h-4 w-4" />
                    QR Payload
                  </div>
                  <pre className="max-h-44 overflow-auto rounded bg-background/60 p-2 text-xs text-muted-foreground">
                    {status.whatsapp.qr}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void showWhatsAppQr()} disabled={Boolean(busy["whatsapp-connect"])}>
                  {busy["whatsapp-connect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Show QR
                </Button>
                <Button variant="outline" onClick={() => void relinkWhatsApp()} disabled={Boolean(busy["whatsapp-relink"])}>
                  {busy["whatsapp-relink"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Relink
                </Button>
                <Button variant="outline" onClick={() => void waitForScan()} disabled={Boolean(busy["whatsapp-wait"])}>
                  {busy["whatsapp-wait"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Wait for Scan
                </Button>
                <Button variant="destructive" onClick={() => void logoutWhatsApp()} disabled={Boolean(busy["whatsapp-disconnect"])}>
                  {busy["whatsapp-disconnect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
                  Logout
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">WhatsApp Tips</CardTitle>
              <CardDescription>Keep this tab open while pairing to capture QR refresh cycles.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                Use <strong>Linked Devices</strong> in your WhatsApp app to scan.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                If session expires, press <strong>Relink</strong> to reset auth and issue a fresh QR.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                For workflow trigger, use <code>message-trigger</code> and channel <code>whatsapp</code>.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="discord" className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card className="border-violet-400/25 bg-gradient-to-b from-violet-500/10 to-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Discord Bot Connection</CardTitle>
                <StatusBadge connected={status.discord.connected} />
              </div>
              <CardDescription>Connect token and handle server/DM messages through Discord trigger workflows.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <StatChip label="Mode" value="Gateway" />
                <StatChip label="Bot Username" value={status.discord.username || "n/a"} />
              </div>

              <ChannelCallout state={callouts.discord ?? null} />

              {!status.discord.connected ? (
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={discordToken}
                    onChange={(event) => setDiscordToken(event.target.value)}
                    placeholder="Paste Discord bot token"
                  />
                  <p className="text-xs text-muted-foreground">
                    Token is masked here and should live in environment/secrets after validation.
                  </p>
                  <Button
                    className="w-full"
                    onClick={() => void connectDiscord()}
                    disabled={Boolean(busy["discord-connect"]) || !discordToken.trim()}
                  >
                    {busy["discord-connect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Connect Discord Bot
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => void disconnectDiscord()}
                  disabled={Boolean(busy["discord-disconnect"])}
                >
                  {busy["discord-disconnect"] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
                  Disconnect Discord Bot
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Discord Setup Notes</CardTitle>
              <CardDescription>Minimum required Discord app settings.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                Enable <strong>Message Content Intent</strong> in Discord developer portal.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                Invite bot with read/send permissions for target channels.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                Use <code>discord-trigger</code> node for incoming channel events.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="playbook" className="mt-4">
          <Card className="border-primary/25 bg-gradient-to-b from-primary/10 to-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Channel Validation Playbook
              </CardTitle>
              <CardDescription>Use this sequence to verify onboarding and real message delivery.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm md:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-1 font-semibold">1. Connect channel</div>
                Link Telegram or WhatsApp from dedicated tabs above.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-1 font-semibold">2. Build trigger workflow</div>
                Create or use a template with matching trigger node.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-1 font-semibold">3. Run external message test</div>
                Send message in Telegram/Discord/WhatsApp and observe execution.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-1 font-semibold">4. Validate side effects</div>
                Confirm board task creation, tags, or memory writes as expected.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3">
                <div className="mb-1 font-semibold">5. Verify response path</div>
                Ensure final assistant response is delivered to the originating channel.
              </div>
              <div className="rounded-xl border border-border/60 bg-card/40 p-3 md:col-span-2">
                <div className="mb-1 font-semibold">Google Chat webhook</div>
                Configure Google Chat app request URL:
                <br />
                <code>/api/channels/google-chat</code>
                <br />
                Then use workflow trigger <code>message-trigger</code> + <code>google-chat</code>.
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Security
                </div>
                Keep tokens in environment or secrets settings only. Never commit channel tokens into code or workflow JSON.
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">Implemented vs Planned Channels</div>
            <div className="text-xs text-muted-foreground">
              Implemented now: WebChat, Telegram, Discord, WhatsApp, Google Chat webhook. Planned parity: Slack, Signal.
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline" className="gap-1"><MessageSquare className="h-3 w-3" /> WebChat</Badge>
            <Badge variant="outline" className="gap-1"><Send className="h-3 w-3" /> Telegram</Badge>
            <Badge variant="outline" className="gap-1"><MessageCircle className="h-3 w-3" /> WhatsApp</Badge>
            <Badge variant="outline" className="gap-1"><Bot className="h-3 w-3" /> Discord</Badge>
            <Badge variant="outline" className="gap-1"><Workflow className="h-3 w-3" /> Google Chat</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}
