import { setCssToken } from "@/lib/design-studio/tokens";

export type DesignPatch =
  | { kind: "set-text"; id: string; value: string }
  | { kind: "set-link"; id: string; text?: string; href?: string }
  | { kind: "set-image"; id: string; src?: string; alt?: string }
  | { kind: "set-style"; id: string; styles: Record<string, string | null> }
  | { kind: "set-class"; id: string; add?: string[]; remove?: string[] }
  | { kind: "set-token"; token: string; value: string }
  | { kind: "set-attributes"; id: string; attributes: Record<string, string | null> }
  | { kind: "replace-outer-html"; id: string; html: string }
  | { kind: "remove-element"; id: string }
  | { kind: "set-full-source"; source: string };

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSafeText(value: string): string {
  return String(value || "").replace(/[<>]/g, "");
}

function assertSafeAttributeValue(value: string): string {
  const text = String(value || "");
  if (/[<>`]/.test(text) || /^\s*javascript:/i.test(text)) throw new Error("Unsafe attribute value");
  return text.replace(/"/g, "&quot;");
}

function parseAttributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([:@a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrs))) {
    out.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function renderAttributes(attrs: Map<string, string>): string {
  return Array.from(attrs.entries())
    .map(([key, value]) => value === "" ? key : `${key}="${assertSafeAttributeValue(value)}"`)
    .join(" ");
}

function updateElementAttributes(source: string, patchId: string, update: (attrs: Map<string, string>, tag: string, inner: string) => string | null): string {
  const re = findElementPattern(patchId);
  const match = re.exec(source);
  if (!match) throw new Error(`Target not found: ${patchId}`);
  const tag = match[1];
  const attrs = parseAttributes(match[2] || "");
  const inner = match[3] || "";
  const replacement = update(attrs, tag, inner);
  if (replacement === null) return source.replace(re, "");
  return source.replace(re, replacement);
}

function findElementPattern(id: string): RegExp {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid data-disp8ch-id");
  return new RegExp(`<([a-z0-9-]+)\\b([^>]*\\bdata-disp8ch-id=["']${escapeRe(id)}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`, "i");
}

export function applyDesignPatch(source: string, patch: DesignPatch): string {
  if (patch.kind === "set-full-source") return patch.source;
  if (patch.kind === "set-token") return setCssToken(source, patch.token, patch.value);

  const re = findElementPattern("id" in patch ? patch.id : "");
  const match = re.exec(source);
  if (!match) throw new Error(`Target not found: ${"id" in patch ? patch.id : ""}`);

  if (patch.kind === "set-text") {
    return source.replace(re, `<$1$2>${assertSafeText(patch.value)}</$1>`);
  }

  if (patch.kind === "set-link") {
    let attrs = match[2] || "";
    if (patch.href !== undefined) {
      if (/^\s*javascript:/i.test(patch.href)) throw new Error("Unsafe href");
      attrs = /\bhref=["'][^"']*["']/i.test(attrs)
        ? attrs.replace(/\bhref=["'][^"']*["']/i, `href="${patch.href}"`)
        : `${attrs} href="${patch.href}"`;
    }
    const text = patch.text === undefined ? match[3] : assertSafeText(patch.text);
    return source.replace(re, `<$1${attrs}>${text}</$1>`);
  }

  if (patch.kind === "set-image") {
    return updateElementAttributes(source, patch.id, (attrs, tag, inner) => {
      if (patch.src !== undefined) attrs.set("src", patch.src);
      if (patch.alt !== undefined) attrs.set("alt", patch.alt);
      return `<${tag} ${renderAttributes(attrs)}>${inner}</${tag}>`;
    });
  }

  if (patch.kind === "set-style") {
    return updateElementAttributes(source, patch.id, (attrs, tag, inner) => {
      const existing = new Map(
        String(attrs.get("style") || "")
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf(":");
            return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as [string, string];
          }),
      );
      for (const [key, value] of Object.entries(patch.styles || {})) {
        if (!/^[-a-zA-Z0-9]+$/.test(key)) throw new Error(`Unsafe CSS property: ${key}`);
        if (value === null) existing.delete(key);
        else if (/[<>{}`]/.test(value)) throw new Error("Unsafe CSS value");
        else existing.set(key, value);
      }
      const style = Array.from(existing.entries()).map(([key, value]) => `${key}: ${value}`).join("; ");
      if (style) attrs.set("style", style);
      else attrs.delete("style");
      return `<${tag} ${renderAttributes(attrs)}>${inner}</${tag}>`;
    });
  }

  if (patch.kind === "set-class") {
    return updateElementAttributes(source, patch.id, (attrs, tag, inner) => {
      const classes = new Set(String(attrs.get("class") || "").split(/\s+/).filter(Boolean));
      for (const item of patch.remove || []) classes.delete(item);
      for (const item of patch.add || []) {
        if (!/^[-_a-zA-Z0-9:\/]+$/.test(item)) throw new Error(`Unsafe class: ${item}`);
        classes.add(item);
      }
      if (classes.size) attrs.set("class", Array.from(classes).join(" "));
      else attrs.delete("class");
      return `<${tag} ${renderAttributes(attrs)}>${inner}</${tag}>`;
    });
  }

  if (patch.kind === "set-attributes") {
    return updateElementAttributes(source, patch.id, (attrs, tag, inner) => {
      for (const [key, value] of Object.entries(patch.attributes || {})) {
        if (/^on/i.test(key) || !/^[:a-zA-Z0-9_-]+$/.test(key)) throw new Error(`Unsafe attribute: ${key}`);
        if (["data-disp8ch-id", "data-disp8ch-edit", "data-disp8ch-label"].includes(key) && value === null) {
          throw new Error(`Protected attribute cannot be removed: ${key}`);
        }
        if (value === null) attrs.delete(key);
        else attrs.set(key, value);
      }
      return `<${tag} ${renderAttributes(attrs)}>${inner}</${tag}>`;
    });
  }

  if (patch.kind === "replace-outer-html") {
    if (!new RegExp(`\\bdata-disp8ch-id=["']${escapeRe(patch.id)}["']`, "i").test(patch.html)) {
      throw new Error("Replacement must preserve data-disp8ch-id");
    }
    if (/<script\b/i.test(patch.html) || /\son\w+=/i.test(patch.html)) throw new Error("Unsafe replacement HTML");
    return source.replace(re, patch.html);
  }

  if (patch.kind === "remove-element") {
    const without = source.replace(re, "");
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(without);
    if (bodyMatch && !bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").trim()) {
      throw new Error("Removing the last body element is blocked.");
    }
    return without;
  }

  return source;
}
