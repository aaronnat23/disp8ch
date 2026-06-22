export type DesignEditTarget = {
  id: string;
  kind: string;
  label: string;
  tag: string;
  text: string;
};

export function extractDesignEditTargets(html: string): DesignEditTarget[] {
  const targets: DesignEditTarget[] = [];
  const seen = new Set<string>();
  const re = /<([a-z0-9-]+)\b([^>]*\bdata-disp8ch-id=["']([^"']+)["'][^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && targets.length < 200) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    const id = match[3];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = /\bdata-disp8ch-edit=["']([^"']+)["']/i.exec(attrs)?.[1] || "container";
    const label = /\bdata-disp8ch-label=["']([^"']+)["']/i.exec(attrs)?.[1] || id;
    const close = new RegExp(`</${tag}>`, "i");
    const rest = html.slice(re.lastIndex);
    const closeMatch = close.exec(rest);
    const inner = closeMatch ? rest.slice(0, closeMatch.index) : "";
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    targets.push({ id, kind, label, tag, text });
  }
  return targets;
}
