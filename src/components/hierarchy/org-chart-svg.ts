export type OrgChartAgent = {
  name: string;
  role?: string;
  reportsTo?: string | null;
  id: string;
};

interface OrgChartStyle {
  name: string;
  bg: string;
  cardBg: string;
  cardBorder: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
  connectorColor: string;
  fontFamily: string;
}

const STYLES: Record<string, OrgChartStyle> = {
  monochrome: {
    name: "Monochrome",
    bg: "#18181b",
    cardBg: "#27272a",
    cardBorder: "#3f3f46",
    textColor: "#fafafa",
    mutedColor: "#a1a1aa",
    accentColor: "#e94560",
    connectorColor: "#52525b",
    fontFamily: "JetBrains Mono, monospace",
  },
  nebula: {
    name: "Nebula",
    bg: "#0f0c29",
    cardBg: "rgba(255,255,255,0.07)",
    cardBorder: "rgba(255,255,255,0.12)",
    textColor: "#e0e0ff",
    mutedColor: "#8888cc",
    accentColor: "#7c3aed",
    connectorColor: "rgba(124,58,237,0.4)",
    fontFamily: "Space Grotesk, sans-serif",
  },
  schematic: {
    name: "Schematic",
    bg: "#0d1117",
    cardBg: "#161b22",
    cardBorder: "#30363d",
    textColor: "#c9d1d9",
    mutedColor: "#8b949e",
    accentColor: "#58a6ff",
    connectorColor: "#30363d",
    fontFamily: "JetBrains Mono, monospace",
  },
};

export const ORG_CHART_STYLES: Record<string, string> = {
  monochrome: "Monochrome",
  nebula: "Nebula",
  schematic: "Schematic",
};

const CARD_W = 180;
const CARD_H = 64;
const GAP_X = 60;
const GAP_Y = 80;
const AVATAR_R = 14;

type TreeNode = {
  agent: OrgChartAgent;
  children: TreeNode[];
};

function buildSubtree(agent: OrgChartAgent, all: OrgChartAgent[]): TreeNode {
  return {
    agent,
    children: all.filter((a) => a.reportsTo === agent.id).map((a) => buildSubtree(a, all)),
  };
}

function buildTree(agents: OrgChartAgent[]): TreeNode | null {
  const root = agents.find((a) => !a.reportsTo) || agents[0];
  if (!root) return null;
  return {
    agent: root,
    children: agents.filter((a) => a.reportsTo === root.id).map((a) => buildSubtree(a, agents)),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function subtreeWidth(node: TreeNode): number {
  if (node.children.length === 0) return CARD_W;
  let w = 0;
  for (const child of node.children) {
    w += subtreeWidth(child);
  }
  return Math.max(CARD_W, w + (node.children.length - 1) * GAP_X);
}

function computeHeight(node: TreeNode | null): number {
  if (!node) return 0;
  let maxChildHeight = 0;
  for (const child of node.children) {
    maxChildHeight = Math.max(maxChildHeight, computeHeight(child));
  }
  return CARD_H + (maxChildHeight > 0 ? GAP_Y + maxChildHeight : 0);
}

function renderCard(x: number, y: number, agent: OrgChartAgent, style: OrgChartStyle): string {
  return `<g transform="translate(${x},${y})">
    <rect class="card" width="${CARD_W}" height="${CARD_H}"/>
    <g transform="translate(16,${(CARD_H - AVATAR_R * 2) / 2})">
      <circle class="avatar" cx="${AVATAR_R}" cy="${AVATAR_R}" r="${AVATAR_R}"/>
      <text class="avatar" x="${AVATAR_R}" y="${AVATAR_R + 4}" text-anchor="middle">${escapeXml((agent.name[0] || "A").toUpperCase())}</text>
    </g>
    <text class="name" x="${16 + AVATAR_R * 2 + 12}" y="${CARD_H / 2 - 4}">${escapeXml(agent.name)}</text>
    <text class="role" x="${16 + AVATAR_R * 2 + 12}" y="${CARD_H / 2 + 14}">${escapeXml(agent.role || "Agent")}</text>
  </g>`;
}

function renderMoreCard(x: number, y: number, count: number, style: OrgChartStyle): string {
  return `<g transform="translate(${x},${y})">
    <rect class="card" width="${CARD_W}" height="${CARD_H}" stroke-dasharray="4,4" opacity="0.5"/>
    <text class="more-name" x="${CARD_W / 2}" y="${CARD_H / 2 + 4}" text-anchor="middle">+${count} more</text>
  </g>`;
}

function layoutAndRender(
  node: TreeNode,
  x: number,
  y: number,
  style: OrgChartStyle,
  emit: (s: string) => void,
): void {
  emit(renderCard(x, y, node.agent, style));

  if (node.children.length === 0) return;

  const MAX_SHOWN = 6;
  const shown = node.children.slice(0, MAX_SHOWN);
  const hidden = node.children.slice(MAX_SHOWN);

  if (shown.length > 0) {
    const childTotalW = shown.length * CARD_W + (shown.length - 1) * GAP_X;
    let cx = x + CARD_W / 2 - childTotalW / 2;

    for (const child of shown) {
      emit(
        `<path class="connector" d="M${x + CARD_W / 2},${y + CARD_H} L${x + CARD_W / 2},${y + CARD_H + GAP_Y / 2} L${cx + CARD_W / 2},${y + CARD_H + GAP_Y / 2} L${cx + CARD_W / 2},${y + CARD_H + GAP_Y}"/>`,
      );
      layoutAndRender(child, cx, y + CARD_H + GAP_Y, style, emit);
      cx += CARD_W + GAP_X;
    }
  }

  if (hidden.length > 0) {
    const cx = x + CARD_W / 2 - CARD_W / 2;
    emit(
      `<path class="connector" d="M${x + CARD_W / 2},${y + CARD_H} L${x + CARD_W / 2},${y + CARD_H + GAP_Y / 2} L${cx + CARD_W / 2},${y + CARD_H + GAP_Y / 2} L${cx + CARD_W / 2},${y + CARD_H + GAP_Y}"/>`,
    );
    emit(renderMoreCard(cx, y + CARD_H + GAP_Y, hidden.length, style));
  }
}

export function generateOrgChartSvg(agents: OrgChartAgent[], styleKey = "monochrome"): string {
  const style = STYLES[styleKey] || STYLES.monochrome;
  const tree = buildTree(agents);
  if (!tree) return `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;

  const totalW = subtreeWidth(tree) + 40;
  const totalH = computeHeight(tree) + 40;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
  <rect width="100%" height="100%" fill="${style.bg}" rx="8"/>
  <style>
    text { font-family: ${style.fontFamily}; }
    .card rect { fill: ${style.cardBg}; stroke: ${style.cardBorder}; stroke-width: 1.5; rx: 8; }
    .card .name { fill: ${style.textColor}; font-size: 13px; font-weight: 600; }
    .card .role { fill: ${style.mutedColor}; font-size: 10px; }
    .more-name { fill: ${style.mutedColor}; font-size: 13px; font-weight: 600; }
    .connector { stroke: ${style.connectorColor}; stroke-width: 1.5; fill: none; }
    .avatar circle { fill: ${style.accentColor}; opacity: 0.2; stroke: ${style.accentColor}; stroke-width: 1; }
    .avatar text { fill: ${style.accentColor}; font-size: 10px; font-weight: 600; }
  </style>`;

  layoutAndRender(tree, (totalW - subtreeWidth(tree)) / 2 + 20, 20, style, (svgObj) => {
    svg += svgObj;
  });

  svg += `</svg>`;
  return svg;
}
