"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  HelpCircle,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Mail,
  HardDrive,
} from "lucide-react";

interface GoogleStatus {
  configured: boolean;
  email: string | null;
  expiresAt: number | null;
  expired?: boolean;
  scopes: string[] | null;
}

export function GoogleSetupDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/auth/google")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setStatus(data.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Google Setup Guide">
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Google Setup Guide</DialogTitle>
        </DialogHeader>

        {/* Status Badge */}
        <div className="flex items-center gap-2">
          {loading ? (
            <Badge variant="secondary">Checking...</Badge>
          ) : status?.configured ? (
            <>
              <CheckCircle className="h-4 w-4 text-green-500" />
              <Badge variant="default">Connected as {status.email}</Badge>
              {status.expired && (
                <Badge variant="destructive">Token expired</Badge>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <Badge variant="secondary">Not configured</Badge>
            </>
          )}
        </div>

        <Separator />

        {/* Gmail OAuth Section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-red-500" />
            <h3 className="text-lg font-semibold">Gmail (OAuth 2.0)</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            OAuth lets disp8ch read and send Gmail on your behalf. Uses PKCE flow — credentials are saved to the database, no <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code> changes needed.
          </p>
          <ol className="list-inside list-decimal space-y-2 text-sm">
            <li>
              Go to{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                Google Cloud Console → Credentials
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>
              Create an <strong>OAuth Client ID</strong> (type: <strong>Desktop app</strong>). Copy both the <strong>Client ID</strong> and <strong>Client Secret</strong>.
            </li>
            <li>
              Go to{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials/consent"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                OAuth Consent Screen
                <ExternalLink className="h-3 w-3" />
              </a>
              {" "}→ add your Google email as a <strong>test user</strong>.
            </li>
            <li>
              Under{" "}
              <a
                href="https://console.cloud.google.com/apis/library"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                API Library
                <ExternalLink className="h-3 w-3" />
              </a>
              , enable the <strong>Gmail API</strong> (and Drive API if needed).
            </li>
            <li>
              Run the auth flow:
              <pre className="mt-1 rounded bg-muted p-2 text-xs">dpc auth google</pre>
              It will prompt for your Client ID and Client Secret, then open your browser for Google sign-in. Tokens are stored locally in the database.
            </li>
            <li>
              Verify:
              <pre className="mt-1 rounded bg-muted p-2 text-xs">dpc auth status</pre>
            </li>
          </ol>
        </div>

        <Separator />

        {/* Google Drive Service Account Section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-blue-500" />
            <h3 className="text-lg font-semibold">Google Drive (Service Account)</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            For Drive API access without user interaction, use a service account.
          </p>
          <ol className="list-inside list-decimal space-y-2 text-sm">
            <li>
              Go to{" "}
              <a
                href="https://console.cloud.google.com/iam-admin/serviceaccounts"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline"
              >
                Service Accounts
                <ExternalLink className="h-3 w-3" />
              </a>
              {" "}→ Create a service account.
            </li>
            <li>
              Create a <strong>JSON key</strong> for the service account and download it.
            </li>
            <li>
              Add the key path to <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code>:
              <pre className="mt-1 rounded bg-muted p-2 text-xs">
                GOOGLE_SERVICE_ACCOUNT_KEY=./data/service-account.json
              </pre>
            </li>
            <li>
              <strong>Share</strong> any Google Drive folders/files with the service account email
              (e.g., <code className="rounded bg-muted px-1.5 py-0.5 text-xs">my-sa@project.iam.gserviceaccount.com</code>).
            </li>
          </ol>
        </div>

        <Separator />

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Manage your connection in <strong>Settings → Google</strong>.</p>
          <p>CLI commands: <code className="rounded bg-muted px-1 py-0.5">dpc auth google</code> | <code className="rounded bg-muted px-1 py-0.5">dpc auth status</code> | <code className="rounded bg-muted px-1 py-0.5">dpc auth revoke</code></p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
