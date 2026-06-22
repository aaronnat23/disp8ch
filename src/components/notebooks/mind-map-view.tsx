"use client";

import { useCallback, useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Download, FileImage, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

type MindMapItem = {
  label: string;
  citations?: string[];
  children?: MindMapItem[];
};

type MindMapViewProps = {
  title: string;
  payload: Record<string, unknown>;
};

type FlatMindMap = {
  nodes: Array<Node<{ label: string; citations: string[] }>>;
  edges: Edge[];
  items: Array<{ id: string; parentId: string | null; depth: number; label: string; citations: string[] }>;
};

function safeItems(payload: Record<string, unknown>): MindMapItem[] {
  if (!Array.isArray(payload.nodes)) return [];
  const visit = (raw: unknown): MindMapItem | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const label = String(value.label || "").trim();
    if (!label) return null;
    return {
      label,
      citations: Array.isArray(value.citations) ? value.citations.map(String) : [],
      children: Array.isArray(value.children)
        ? value.children.map(visit).filter((item): item is MindMapItem => Boolean(item))
        : [],
    };
  };
  return payload.nodes.map(visit).filter((item): item is MindMapItem => Boolean(item));
}

function flattenMindMap(payload: Record<string, unknown>): FlatMindMap {
  const roots = safeItems(payload);
  const items: FlatMindMap["items"] = [];
  const rowsByDepth = new Map<number, number>();
  let sequence = 0;

  const visit = (item: MindMapItem, depth: number, parentId: string | null) => {
    const id = `mind-map-${sequence++}`;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    items.push({
      id,
      parentId,
      depth,
      label: item.label,
      citations: item.citations ?? [],
    });
    for (const child of item.children ?? []) visit(child, depth + 1, id);
  };
  for (const root of roots) visit(root, 0, null);

  const nodes = items.map((item) => {
    const sameDepth = items.filter((candidate) => candidate.depth === item.depth);
    const row = sameDepth.findIndex((candidate) => candidate.id === item.id);
    return {
      id: item.id,
      position: { x: item.depth * 290, y: row * 125 },
      data: { label: item.label, citations: item.citations },
      style: {
        width: 230,
        borderRadius: 6,
        border: item.depth === 0 ? "1px solid hsl(var(--primary))" : "1px solid hsl(var(--border))",
        background: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        padding: 12,
        fontSize: 12,
        lineHeight: 1.4,
      },
      draggable: false,
      selectable: true,
    } satisfies Node<{ label: string; citations: string[] }>;
  });
  const edges = items
    .filter((item) => item.parentId)
    .map((item) => ({
      id: `${item.parentId}-${item.id}`,
      source: item.parentId!,
      target: item.id,
      type: "smoothstep",
    } satisfies Edge));
  return { nodes, edges, items };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapLabel(value: string, length = 30): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > length) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function createSvg(title: string, graph: FlatMindMap): string {
  const positions = new Map(graph.nodes.map((node) => [node.id, node.position]));
  const width = Math.max(560, ...graph.nodes.map((node) => node.position.x + 270));
  const height = Math.max(280, ...graph.nodes.map((node) => node.position.y + 110));
  const lines = graph.edges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return "";
    return `<path d="M ${source.x + 230} ${source.y + 45} C ${source.x + 260} ${source.y + 45}, ${target.x - 30} ${target.y + 45}, ${target.x} ${target.y + 45}" fill="none" stroke="#6b7280" stroke-width="2"/>`;
  }).join("");
  const boxes = graph.items.map((item) => {
    const position = positions.get(item.id) ?? { x: 0, y: 0 };
    const labelLines = wrapLabel(item.label);
    const text = labelLines.map((line, index) =>
      `<text x="${position.x + 14}" y="${position.y + 27 + index * 17}" fill="#111827" font-family="Arial, sans-serif" font-size="13">${escapeXml(line)}</text>`,
    ).join("");
    const citation = item.citations[0]
      ? `<text x="${position.x + 14}" y="${position.y + 91}" fill="#6b7280" font-family="Arial, sans-serif" font-size="10">${escapeXml(item.citations[0].slice(0, 42))}</text>`
      : "";
    return `<g><rect x="${position.x}" y="${position.y}" width="230" height="100" rx="6" fill="#ffffff" stroke="${item.depth === 0 ? "#dc2626" : "#d1d5db"}" stroke-width="${item.depth === 0 ? 2 : 1}"/>${text}${citation}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f9fafb"/><title>${escapeXml(title)}</title>${lines}${boxes}</svg>`;
}

function downloadBlob(contents: BlobPart, type: string, fileName: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileBase(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mind-map";
}

function MindMapCanvas({ title, payload }: MindMapViewProps) {
  const graph = useMemo(() => flattenMindMap(payload), [payload]);
  const exportSvg = useCallback(() => {
    downloadBlob(createSvg(title, graph), "image/svg+xml;charset=utf-8", `${fileBase(title)}.svg`);
  }, [graph, title]);
  const exportMarkdown = useCallback(() => {
    const markdown = graph.items.map((item) => {
      const citations = item.citations.length ? ` ${item.citations.map((citation) => `[${citation}]`).join(" ")}` : "";
      return `${"  ".repeat(item.depth)}- ${item.label}${citations}`;
    }).join("\n");
    downloadBlob(`# ${title}\n\n${markdown}\n`, "text/markdown;charset=utf-8", `${fileBase(title)}.md`);
  }, [graph.items, title]);
  const exportPng = useCallback(() => {
    const svg = createSvg(title, graph);
    const image = new Image();
    const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, "image/png", `${fileBase(title)}.png`);
        URL.revokeObjectURL(source);
      }, "image/png");
    };
    image.src = source;
  }, [graph, title]);

  if (graph.nodes.length === 0) {
    return <div className="border border-dashed p-3 text-xs text-muted-foreground">This mind map has no nodes yet.</div>;
  }

  return (
    <div data-testid="mind-map-view" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={exportSvg} title="Export mind map as SVG">
          <Download className="mr-2 h-4 w-4" /> SVG
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={exportPng} title="Export mind map as PNG">
          <FileImage className="mr-2 h-4 w-4" /> PNG
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={exportMarkdown} title="Export mind map as Markdown">
          <FileText className="mr-2 h-4 w-4" /> Markdown
        </Button>
      </div>
      <div className="h-[360px] min-h-[280px] w-full overflow-hidden border bg-background">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
          panOnDrag
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function MindMapView(props: MindMapViewProps) {
  return (
    <ReactFlowProvider>
      <MindMapCanvas {...props} />
    </ReactFlowProvider>
  );
}
