"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Trash2,
  ExternalLink,
  Loader2,
} from "lucide-react";

interface GoogleStatus {
  configured: boolean;
  email: string | null;
  expiresAt: number | null;
  expired?: boolean;
  scopes: string[] | null;
}

export function GoogleSettings() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/google");
      const data = await res.json();
      if (data.success) setStatus(data.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const refreshToken = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/auth/google", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        await fetchStatus();
      }
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  };

  const revokeToken = async () => {
    setRevoking(true);
    try {
      const res = await fetch("/api/auth/google", { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setStatus({ configured: false, email: null, expiresAt: null, scopes: null });
      }
    } catch {
      // ignore
    } finally {
      setRevoking(false);
    }
  };

  const formatExpiry = (ts: number | null) => {
    if (!ts) return "Unknown";
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <div className="space-y-4">
      {/* Connection Status Card */}
      <Card>
        <CardHeader>
          <CardTitle>Google OAuth Status</CardTitle>
          <CardDescription>
            Manage your Google account connection for Gmail and Drive access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking connection...
            </div>
          ) : status?.configured ? (
            <>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm font-medium">Connected</span>
                  {status.expired && (
                    <Badge variant="destructive">Token expired</Badge>
                  )}
                </div>

                <div className="grid gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Email</span>
                    <span>{status.email || "Unknown"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Token expires</span>
                    <span>{formatExpiry(status.expiresAt)}</span>
                  </div>
                  {status.scopes && status.scopes.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Scopes</span>
                      <div className="flex flex-wrap gap-1">
                        {status.scopes.map((scope) => {
                          const short = scope.split("/").pop() || scope;
                          return (
                            <Badge key={scope} variant="secondary" className="text-xs">
                              {short}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={refreshToken}
                  disabled={refreshing}
                >
                  {refreshing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Refresh Token
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={revokeToken}
                  disabled={revoking}
                >
                  {revoking ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Revoke
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Not configured</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">dpc auth google</code> in
                your terminal to start the OAuth flow.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Setup Reference Card */}
      <Card>
        <CardHeader>
          <CardTitle>Setup Instructions</CardTitle>
          <CardDescription>
            How to configure Google OAuth for Gmail API access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="list-inside list-decimal space-y-2">
            <li>
              Create an{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                OAuth Client ID (Desktop app)
                <ExternalLink className="h-3 w-3" />
              </a>
              {" "}— copy both the <strong>Client ID</strong> and <strong>Client Secret</strong>
            </li>
            <li>
              Add your email as a{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials/consent"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                test user
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>
              Enable the{" "}
              <a
                href="https://console.cloud.google.com/apis/library"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                Gmail API
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>
              Run <code className="rounded bg-muted px-1 py-0.5">dpc auth google</code> — it will
              prompt for your Client ID and Client Secret, then open a browser for sign-in.
              Credentials are saved to the database, no <code className="rounded bg-muted px-1 py-0.5">.env.local</code> changes needed.
            </li>
          </ol>

          <Separator />

          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium">CLI Commands</p>
            <pre className="rounded bg-muted p-2">
{`dpc auth google    # Start OAuth flow
dpc auth status    # Check connection status
dpc auth revoke    # Revoke and delete token`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
