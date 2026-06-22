"use client";

import React, { useState } from "react";
import type { NodeFieldSchema } from "@/lib/engine/node-contracts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Props = {
  field: NodeFieldSchema;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  sampleData?: Record<string, unknown>;
};

function isCronValid(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

export function ContractFieldEditor({
  field,
  value,
  onChange,
  disabled,
  sampleData,
}: Props): React.ReactElement {
  const [jsonError, setJsonError] = useState<string | null>(null);

  const strValue = value === null || value === undefined ? "" : String(value);
  const numValue = typeof value === "number" ? value : Number(strValue) || 0;
  const boolValue = typeof value === "boolean" ? value : strValue === "true";

  const labelNode = (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Label className="text-xs">
        {field.label}
        {field.required && (
          <span className="text-red-500 ml-0.5" aria-label="required">*</span>
        )}
      </Label>
      {field.uiOnly && (
        <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 font-normal">
          UI only
        </Badge>
      )}
      {field.planned && (
        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground">
          planned
        </Badge>
      )}
    </div>
  );

  const helpNode = field.help ? (
    <p className="text-[11px] text-muted-foreground leading-tight">{field.help}</p>
  ) : null;

  switch (field.type) {
    case "string":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {helpNode}
        </div>
      );

    case "number":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            type="number"
            value={numValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, Number(e.target.value))}
          />
          {helpNode}
        </div>
      );

    case "boolean":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={boolValue}
              disabled={disabled || field.planned}
              onClick={() => onChange(field.key, !boolValue)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                disabled || field.planned ? "opacity-50 cursor-not-allowed" : ""
              } ${boolValue ? "bg-emerald-500" : "bg-muted"}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  boolValue ? "translate-x-[18px]" : "translate-x-0.5"
                }`}
              />
            </button>
            <span className="text-xs text-muted-foreground">{boolValue ? "On" : "Off"}</span>
          </div>
          {helpNode}
        </div>
      );

    case "select":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Select
            value={strValue || String(field.defaultValue ?? "")}
            onValueChange={(v) => onChange(field.key, v)}
            disabled={disabled || field.planned}
          >
            <SelectTrigger>
              <SelectValue placeholder={field.placeholder || "Select..."} />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {helpNode}
        </div>
      );

    case "json": {
      const handleJsonChange = (raw: string) => {
        onChange(field.key, raw);
        if (!raw.trim()) {
          setJsonError(null);
          return;
        }
        try {
          JSON.parse(raw);
          setJsonError(null);
        } catch (err) {
          setJsonError(err instanceof Error ? err.message : "Invalid JSON");
        }
      };
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Textarea
            rows={3}
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => handleJsonChange(e.target.value)}
            className={jsonError ? "border-red-500 focus-visible:ring-red-500" : ""}
          />
          {jsonError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{jsonError}</p>
          )}
          {helpNode}
        </div>
      );
    }

    case "code":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Textarea
            rows={5}
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
            className="font-mono text-xs"
          />
          {helpNode}
        </div>
      );

    case "template": {
      const sampleKeys = sampleData ? Object.keys(sampleData) : [];
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Textarea
            rows={3}
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {sampleKeys.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sampleKeys.slice(0, 8).map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  className="h-5 px-1.5 text-[10px] font-mono"
                  onClick={() => onChange(field.key, strValue + `{{${key}}}`)}
                >
                  {`{{${key}}}`}
                </Button>
              ))}
            </div>
          )}
          {helpNode}
        </div>
      );
    }

    case "secret":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            type="password"
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
            autoComplete="new-password"
          />
          {helpNode}
        </div>
      );

    case "cron": {
      const isValid = !strValue || isCronValid(strValue);
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            value={strValue}
            placeholder={field.placeholder ?? "0 9 * * *"}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
            className={!isValid ? "border-yellow-500 focus-visible:ring-yellow-500" : ""}
          />
          {!isValid && (
            <p className="text-[11px] text-yellow-600 dark:text-yellow-400">
              Expected 5 fields: minute hour day month weekday
            </p>
          )}
          {isValid && helpNode}
        </div>
      );
    }

    case "auth":
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            value={strValue}
            placeholder={field.placeholder ?? "Bearer token or secret:MY_API_KEY"}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {helpNode}
        </div>
      );

    default:
      return (
        <div className="space-y-1.5">
          {labelNode}
          <Input
            value={strValue}
            placeholder={field.placeholder}
            disabled={disabled || field.planned}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {helpNode}
        </div>
      );
  }
}
