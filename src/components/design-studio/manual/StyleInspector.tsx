"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DesignEditTarget } from "@/components/design-studio/preview/selection-types";

type Field = {
  css: string;
  computed: string;
  label: string;
  type?: "text" | "number" | "color" | "select";
  options?: string[];
};

const GROUPS: Array<{ label: string; open?: boolean; fields: Field[] }> = [
  {
    label: "Layout & position",
    open: true,
    fields: [
      { css: "position", computed: "position", label: "Position", type: "select", options: ["static", "relative", "absolute", "fixed", "sticky"] },
      { css: "left", computed: "left", label: "X / left" },
      { css: "top", computed: "top", label: "Y / top" },
      { css: "width", computed: "width", label: "Width" },
      { css: "height", computed: "height", label: "Height" },
      { css: "max-width", computed: "maxWidth", label: "Max width" },
      { css: "min-height", computed: "minHeight", label: "Min height" },
      { css: "z-index", computed: "zIndex", label: "Layer / z" },
    ],
  },
  {
    label: "Typography",
    open: true,
    fields: [
      { css: "font-family", computed: "fontFamily", label: "Font" },
      { css: "font-size", computed: "fontSize", label: "Text size" },
      { css: "font-weight", computed: "fontWeight", label: "Weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"] },
      { css: "line-height", computed: "lineHeight", label: "Line height" },
      { css: "letter-spacing", computed: "letterSpacing", label: "Letter spacing" },
      { css: "text-align", computed: "textAlign", label: "Align", type: "select", options: ["left", "center", "right", "justify"] },
      { css: "color", computed: "color", label: "Text color", type: "color" },
    ],
  },
  {
    label: "Spacing",
    fields: [
      { css: "margin-top", computed: "marginTop", label: "Margin top" },
      { css: "margin-right", computed: "marginRight", label: "Margin right" },
      { css: "margin-bottom", computed: "marginBottom", label: "Margin bottom" },
      { css: "margin-left", computed: "marginLeft", label: "Margin left" },
      { css: "padding-top", computed: "paddingTop", label: "Padding top" },
      { css: "padding-right", computed: "paddingRight", label: "Padding right" },
      { css: "padding-bottom", computed: "paddingBottom", label: "Padding bottom" },
      { css: "padding-left", computed: "paddingLeft", label: "Padding left" },
      { css: "gap", computed: "gap", label: "Gap" },
    ],
  },
  {
    label: "Fill, border & effects",
    fields: [
      { css: "background-color", computed: "backgroundColor", label: "Fill", type: "color" },
      { css: "border-color", computed: "borderColor", label: "Border color", type: "color" },
      { css: "border-width", computed: "borderWidth", label: "Border width" },
      { css: "border-style", computed: "borderStyle", label: "Border style", type: "select", options: ["none", "solid", "dashed", "dotted"] },
      { css: "border-radius", computed: "borderRadius", label: "Radius" },
      { css: "box-shadow", computed: "boxShadow", label: "Shadow" },
      { css: "opacity", computed: "opacity", label: "Opacity" },
      { css: "transform", computed: "transform", label: "Transform" },
    ],
  },
  {
    label: "Flex & grid",
    fields: [
      { css: "display", computed: "display", label: "Display", type: "select", options: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "none"] },
      { css: "flex-direction", computed: "flexDirection", label: "Direction", type: "select", options: ["row", "column", "row-reverse", "column-reverse"] },
      { css: "justify-content", computed: "justifyContent", label: "Justify", type: "select", options: ["start", "center", "end", "space-between", "space-around", "space-evenly"] },
      { css: "align-items", computed: "alignItems", label: "Align items", type: "select", options: ["start", "center", "end", "stretch", "baseline"] },
      { css: "grid-template-columns", computed: "gridTemplateColumns", label: "Grid columns" },
      { css: "overflow", computed: "overflow", label: "Overflow", type: "select", options: ["visible", "hidden", "auto", "scroll"] },
    ],
  },
];

function rgbToHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const match = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
  if (!match) return "#000000";
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

export function StyleInspector({
  target,
  onPatch,
}: {
  target: DesignEditTarget | null;
  onPatch: (patch: unknown, summary: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  const initial = useMemo(() => {
    const next: Record<string, string> = {};
    for (const group of GROUPS) {
      for (const field of group.fields) next[field.css] = target?.styles?.[field.computed] || "";
    }
    return next;
  }, [target]);

  useEffect(() => {
    setDraft(initial);
    setDirty(new Set());
    // Preview metadata can refresh after iframe load. Keep staged edits when
    // that refresh describes the same selected element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  if (!target) return null;

  const update = (css: string, value: string) => {
    setDraft((current) => ({ ...current, [css]: value }));
    setDirty((current) => new Set(current).add(css));
  };

  const apply = () => {
    const styles = Object.fromEntries(Array.from(dirty).map((css) => [css, draft[css]?.trim() ? draft[css].trim() : null]));
    if (Object.keys(styles).length === 0) return;
    onPatch({ kind: "set-style", id: target.id, styles }, `Style ${target.label}`);
    setDirty(new Set());
  };

  return (
    <div className="space-y-2">
      <div className="rounded border border-border bg-background/60 px-2 py-1.5 text-[10px] text-muted-foreground">
        {target.tag} · {Math.round(target.bounds?.width || 0)} × {Math.round(target.bounds?.height || 0)} px
      </div>
      {GROUPS.map((group) => (
        <details key={group.label} open={group.open} className="rounded border border-border bg-background/40">
          <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium">{group.label}</summary>
          <div className="grid grid-cols-2 gap-2 border-t border-border p-2">
            {group.fields.map((field) => (
              <label key={field.css} className={field.css === "font-family" || field.css === "box-shadow" || field.css === "transform" || field.css === "grid-template-columns" ? "col-span-2 space-y-1" : "space-y-1"}>
                <span className="block text-[10px] text-muted-foreground">{field.label}</span>
                {field.type === "select" ? (
                  <select
                    value={draft[field.css] || ""}
                    onChange={(event) => update(field.css, event.target.value)}
                    className="h-7 w-full min-w-0 rounded border border-border bg-background px-1 text-[10px]"
                  >
                    <option value="">Default</option>
                    {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : field.type === "color" ? (
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={rgbToHex(draft[field.css] || "")}
                      onChange={(event) => update(field.css, event.target.value)}
                      className="h-7 w-8 rounded border border-border bg-transparent p-0.5"
                    />
                    <input
                      value={draft[field.css] || ""}
                      onChange={(event) => update(field.css, event.target.value)}
                      className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[10px]"
                    />
                  </div>
                ) : (
                  <input
                    value={draft[field.css] || ""}
                    onChange={(event) => update(field.css, event.target.value)}
                    placeholder="auto"
                    className="h-7 w-full min-w-0 rounded border border-border bg-background px-1.5 text-[10px]"
                  />
                )}
              </label>
            ))}
          </div>
        </details>
      ))}
      <div className="sticky bottom-0 flex gap-1 bg-card py-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 flex-1 text-[11px]"
          disabled={dirty.size === 0}
          onClick={() => { setDraft(initial); setDirty(new Set()); }}
        >
          Reset
        </Button>
        <Button size="sm" className="h-8 flex-[2] text-[11px]" disabled={dirty.size === 0} onClick={apply}>
          Apply {dirty.size || ""} change{dirty.size === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
