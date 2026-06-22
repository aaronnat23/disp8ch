"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type AuditStatus = "ok" | "warn" | "error";

type AuditFinding = {
  id: string;
  title: string;
  status: AuditStatus;
  summary: string;
  details?: string[];
};

type AuditArea = {
  id: string;
  title: string;
  description: string;
  status: AuditStatus;
  findings: AuditFinding[];
};

type AuditRoute = {
  path: string;
  mode: "public" | "mixed";
  purpose: string;
  exposure: string;
  stateChanging: boolean;
  safeguards: string[];
};

type SecurityAuditReport = {
  ok: boolean;
  checkedAt: string;
  errors: number;
  warnings: number;
  summary: {
    totalRoutes: number;
    protectedRoutes: number;
    operatorRoutes: number;
    adminRoutes: number;
    mixedRoutes: number;
    publicRoutes: number;
    publicStateChangingRoutes: number;
    unexpectedPublicRoutes: number;
    adminTokenConfigured: boolean;
    wsAuthTokenConfigured: boolean;
    secretsEncrypted: boolean;
    teamsAllowlistConfigured: boolean;
    websitePolicyMode: "off" | "blocklist";
    websitePolicyDomains: number;
  };
  areas: AuditArea[];
  publicRoutes: AuditRoute[];
  mixedRoutes: AuditRoute[];
  recommendations: string[];
};

function badgeVariant(status: AuditStatus): "default" | "secondary" | "destructive" {
  if (status === "error") return "destructive";
  if (status === "warn") return "secondary";
  return "default";
}

function renderStatusIcon(status: AuditStatus) {
  if (status === "error") return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
}

function areaIcon(areaId: string) {
  switch (areaId) {
    case "access":
      return <ShieldCheck className="h-4 w-4 text-primary" />;
    case "secrets-auth":
      return <KeyRound className="h-4 w-4 text-primary" />;
    case "browser-network":
      return <Globe className="h-4 w-4 text-primary" />;
    case "ingress":
      return <Lock className="h-4 w-4 text-primary" />;
    case "execution":
      return <TerminalSquare className="h-4 w-4 text-primary" />;
    default:
      return <ShieldCheck className="h-4 w-4 text-primary" />;
  }
}

export function SecuritySettings() {
  const [report, setReport] = useState<SecurityAuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [policyMode, setPolicyMode] = useState<"off" | "blocklist">("off");
  const [policyDomains, setPolicyDomains] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadPolicy = async () => {
    const response = await fetch("/api/config");
    const json = await response.json() as {
      success: boolean;
      data?: { website_policy_mode?: "off" | "blocklist"; website_policy_domains?: string | null };
    };
    if (!json.success || !json.data) return;
    setPolicyMode(json.data.website_policy_mode ?? "off");
    setPolicyDomains(String(json.data.website_policy_domains || ""));
  };

  const runAudit = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/security");
      const json = await response.json() as { success: boolean; data?: SecurityAuditReport; error?: string };
      if (!json.success || !json.data) {
        setError(json.error ?? "Security audit failed.");
        return;
      }
      setReport(json.data);
      await loadPolicy();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const savePolicy = async () => {
    setSavingPolicy(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          website_policy_mode: policyMode,
          website_policy_domains: policyDomains,
        }),
      });
      const json = await response.json() as { success: boolean; error?: string };
      if (!json.success) {
        setError(json.error ?? "Failed to save website policy.");
        return;
      }
      await runAudit();
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingPolicy(false);
    }
  };

  useEffect(() => {
    void runAudit();
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Security Posture</CardTitle>
          <CardDescription>
            Exposure and hardening audit for trust boundaries, public ingress, operator auth, and exec safety.
            Use Validate for runtime readiness checks; use this tab for security posture.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void runAudit()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {loading ? "Refreshing..." : "Refresh Audit"}
            </Button>
            {report ? (
              <>
                <Badge variant={report.ok ? "default" : "destructive"}>
                  {report.ok ? "No critical security errors" : "Security issues detected"}
                </Badge>
                <Badge variant="outline">protected routes: {report.summary.protectedRoutes}</Badge>
                <Badge variant="outline">public routes: {report.summary.publicRoutes}</Badge>
                <Badge variant="outline">public state-changing: {report.summary.publicStateChangingRoutes}</Badge>
                <Badge variant="outline">mixed: {report.summary.mixedRoutes}</Badge>
                <Badge variant="outline">warnings: {report.warnings}</Badge>
                <Badge variant="outline">errors: {report.errors}</Badge>
                <Badge variant="outline">checked: {new Date(report.checkedAt).toLocaleString()}</Badge>
              </>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Admin Token</div>
              <div className="mt-1 text-sm font-semibold">
                {report?.summary.adminTokenConfigured ? "Configured" : "Loopback fallback"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">WS Auth</div>
              <div className="mt-1 text-sm font-semibold">
                {report?.summary.wsAuthTokenConfigured ? "Configured" : "Session or loopback"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Secrets</div>
              <div className="mt-1 text-sm font-semibold">
                {report?.summary.secretsEncrypted ? "Encrypted at rest" : "No master key"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Teams Allowlist</div>
              <div className="mt-1 text-sm font-semibold">
                {report?.summary.teamsAllowlistConfigured ? "Configured" : "Not configured"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Website Policy</div>
              <div className="mt-1 text-sm font-semibold">
                {report?.summary.websitePolicyMode === "blocklist"
                  ? `Blocklist (${report.summary.websitePolicyDomains})`
                  : "Off"}
              </div>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Website Policy</CardTitle>
          <CardDescription>
            Deny specific domains across browser navigation, direct HTTP requests, web ingestion, and targeted web searches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[220px,1fr]">
            <div>
              <Label>Mode</Label>
              <Select value={policyMode} onValueChange={(value) => setPolicyMode(value as "off" | "blocklist")}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="blocklist">Blocklist</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Blocked Domains</Label>
              <Input
                className="mt-1"
                value={policyDomains}
                onChange={(event) => setPolicyDomains(event.target.value)}
                placeholder="example.com, internal.example.org"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma, space, or newline separated domains. Subdomains are blocked automatically.
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={() => void savePolicy()} disabled={savingPolicy}>
            {savingPolicy ? "Saving..." : "Save Website Policy"}
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {loading && !report ? (
          <Card className="xl:col-span-2">
            <CardContent className="py-6">
              <p className="text-sm text-muted-foreground">Running security audit...</p>
            </CardContent>
          </Card>
        ) : null}

        {report?.areas.map((area) => (
          <Card key={area.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {areaIcon(area.id)}
                  <div>
                    <CardTitle>{area.title}</CardTitle>
                    <CardDescription>{area.description}</CardDescription>
                  </div>
                </div>
                <Badge variant={badgeVariant(area.status)}>{area.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {area.findings.map((finding) => (
                <div key={finding.id} className="rounded-md border px-3 py-2">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {renderStatusIcon(finding.status)}
                      <span className="text-sm font-semibold">{finding.title}</span>
                    </div>
                    <Badge variant={badgeVariant(finding.status)}>{finding.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{finding.summary}</p>
                  {finding.details && finding.details.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {finding.details.map((detail, idx) => (
                        <p key={`${finding.id}:${idx}`} className="text-xs text-muted-foreground">
                          - {detail}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Public Surface</CardTitle>
          <CardDescription>
            Intentional unauthenticated endpoints only. This does not repeat runtime readiness checks from Validate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {report?.publicRoutes.length ? (
            report.publicRoutes.map((route) => (
              <div key={route.path} className="rounded-md border px-3 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{route.path}</span>
                  <Badge variant="outline">{route.exposure}</Badge>
                  {route.stateChanging ? <Badge variant="secondary">state changing</Badge> : <Badge variant="outline">read only</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{route.purpose}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {route.safeguards.map((safeguard, idx) => (
                    <Badge key={`${route.path}:${idx}`} variant="outline" className="normal-case tracking-normal">
                      {safeguard}
                    </Badge>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No public routes found.</p>
          )}

          {report?.mixedRoutes.length ? (
            <div className="space-y-2 pt-2">
              <div className="text-sm font-semibold">Mixed-access routes</div>
              {report.mixedRoutes.map((route) => (
                <div key={route.path} className="rounded-md border px-3 py-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{route.path}</span>
                    <Badge variant="outline">mixed</Badge>
                    <Badge variant="secondary">{route.exposure}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{route.purpose}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {route.safeguards.map((safeguard, idx) => (
                      <Badge key={`${route.path}:mixed:${idx}`} variant="outline" className="normal-case tracking-normal">
                        {safeguard}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actionable Recommendations</CardTitle>
          <CardDescription>
            Highest-value next steps from the current security posture.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report?.recommendations.length ? (
            <div className="space-y-2">
              {report.recommendations.map((recommendation, idx) => (
                <div key={`${recommendation}:${idx}`} className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  {recommendation}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No additional hardening recommendations right now.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
