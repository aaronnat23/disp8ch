"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

type SecretMeta = {
  name: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type SecretsPayload = {
  masterKeyConfigured: boolean;
  keySource: string | null;
  secrets: SecretMeta[];
};

function formatDate(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString();
}

export function SecretsSettings() {
  const [payload, setPayload] = useState<SecretsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  const loadSecrets = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/secrets");
      const json = await response.json() as { success: boolean; data?: SecretsPayload; error?: string };
      if (json.success && json.data) {
        setPayload(json.data);
        setStatus(null);
      } else {
        setStatus(json.error ?? "Failed to load secrets.");
      }
    } catch (error) {
      setStatus(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSecrets();
  }, []);

  const normalizedName = useMemo(() => name.trim().toUpperCase(), [name]);

  const saveSecret = async () => {
    if (!normalizedName || !value.trim()) return;
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          value,
          source: "settings-ui",
        }),
      });
      const json = await response.json() as { success: boolean; error?: string };
      if (!json.success) {
        setStatus(json.error ?? "Failed to save secret.");
        return;
      }
      setName("");
      setValue("");
      setStatus(`Saved ${normalizedName}.`);
      await loadSecrets();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (secretName: string) => {
    setDeletingName(secretName);
    setStatus(null);
    try {
      const response = await fetch(`/api/secrets?name=${encodeURIComponent(secretName)}`, { method: "DELETE" });
      const json = await response.json() as { success: boolean; error?: string };
      if (!json.success) {
        setStatus(json.error ?? "Failed to delete secret.");
        return;
      }
      setStatus(`Deleted ${secretName}.`);
      await loadSecrets();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setDeletingName(null);
    }
  };

  const masterReady = payload?.masterKeyConfigured ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Secrets Manager</CardTitle>
          <CardDescription>
            Store API keys and tokens encrypted at rest, then reference them as <code>secret:NAME</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={masterReady ? "default" : "destructive"}>
              {masterReady ? "Master key configured" : "Master key missing"}
            </Badge>
            {payload?.keySource ? <Badge variant="outline">source: {payload.keySource}</Badge> : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadSecrets()}
              disabled={loading}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          {!masterReady ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium text-destructive">
                <AlertCircle className="h-4 w-4" />
                Encryption key required
              </div>
              <p className="text-muted-foreground">
                Set <code>ENCRYPTION_KEY</code> (or <code>SECRETS_MASTER_KEY</code>) in your environment, then restart.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium text-emerald-600">
                <ShieldCheck className="h-4 w-4" />
                Secrets are encrypted
              </div>
              <p className="text-muted-foreground">
                Use these references in model keys: <code>secret:OPENAI_API_KEY</code>, <code>secret:ANTHROPIC_API_KEY</code>.
              </p>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <Label>Secret Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="OPENAI_API_KEY"
              />
            </div>
            <div className="space-y-2">
              <Label>Secret Value</Label>
              <Input
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Paste API key/token"
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={() => void saveSecret()}
                disabled={saving || !normalizedName || !value.trim() || !masterReady}
              >
                <Plus className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {status ? (
            <p className={`text-sm ${status.toLowerCase().includes("failed") || status.toLowerCase().includes("error") ? "text-destructive" : "text-muted-foreground"}`}>
              {status}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stored Secrets</CardTitle>
          <CardDescription>
            Secret values are never returned after save. Update by saving the same name again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !payload ? (
            <p className="text-sm text-muted-foreground">Loading secrets...</p>
          ) : payload && payload.secrets.length > 0 ? (
            <div className="space-y-2">
              {payload.secrets.map((secret) => (
                <div key={secret.name} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-semibold">{secret.name}</span>
                      <Badge variant="secondary">{secret.source}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Updated {formatDate(secret.updatedAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    onClick={() => void removeSecret(secret.name)}
                    disabled={deletingName === secret.name}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No secrets saved yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
