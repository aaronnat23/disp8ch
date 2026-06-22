"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";

type ValidationStatus = "ok" | "warn" | "error";

type ValidationCheck = {
  id: string;
  title: string;
  status: ValidationStatus;
  summary: string;
  details?: string[];
};

type ValidationReport = {
  ok: boolean;
  checkedAt: string;
  errors: number;
  warnings: number;
  checks: ValidationCheck[];
};

function statusBadge(status: ValidationStatus): "default" | "secondary" | "destructive" {
  if (status === "error") return "destructive";
  if (status === "warn") return "secondary";
  return "default";
}

export function ConfigValidationSettings() {
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runValidation = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/config/validate");
      const json = await response.json() as { success: boolean; data?: ValidationReport; error?: string };
      if (!json.success || !json.data) {
        setError(json.error ?? "Validation failed.");
        return;
      }
      setReport(json.data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void runValidation();
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Config Validate</CardTitle>
          <CardDescription>
            Check runtime readiness for models, secrets, webhooks, OAuth, and rate-limit safety.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void runValidation()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {loading ? "Running..." : "Run Validation"}
            </Button>
            {report ? (
              <>
                <Badge variant={report.ok ? "default" : "destructive"}>
                  {report.ok ? "Healthy" : "Needs attention"}
                </Badge>
                <Badge variant="outline">errors: {report.errors}</Badge>
                <Badge variant="outline">warnings: {report.warnings}</Badge>
                <Badge variant="outline">checked: {new Date(report.checkedAt).toLocaleString()}</Badge>
              </>
            ) : null}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Validation Checks</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !report ? (
            <p className="text-sm text-muted-foreground">Running validation...</p>
          ) : report && report.checks.length > 0 ? (
            <div className="space-y-3">
              {report.checks.map((check) => (
                <div key={check.id} className="rounded-md border px-3 py-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {check.status === "ok" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}
                      {check.status === "warn" ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : null}
                      {check.status === "error" ? <XCircle className="h-4 w-4 text-destructive" /> : null}
                      <span className="text-sm font-semibold">{check.title}</span>
                    </div>
                    <Badge variant={statusBadge(check.status)}>{check.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{check.summary}</p>
                  {check.details && check.details.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {check.details.map((detail, idx) => (
                        <p key={`${check.id}:${idx}`} className="text-xs text-muted-foreground">
                          - {detail}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No validation data yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
