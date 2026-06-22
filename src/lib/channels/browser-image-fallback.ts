import fs from "node:fs";
import path from "node:path";
import { logger } from "@/lib/utils/logger";

const log = logger.child("channels:browser-image-fallback");

export async function runBrowserImageFallback(input: {
  sessionId: string;
  shape: string;
  prompt?: string;
}): Promise<{
  ok: boolean;
  file?: string;
  markdown?: string;
  error?: string;
}> {
  try {
    const { executeTool } = await import("@/lib/engine/tools");
    const prompt = input.prompt || "disp8ch AI AI workflow builder";

    // Parse requested dimensions from the prompt
    const parsed = parseRequestedDimensions(prompt, input.shape);
    const width = parsed.width;
    const height = parsed.height;
    const shape = parsed.shape;
    const subject = parsed.subject;

    const html = buildPlaceholderHtml(shape, prompt, width, height);

    const dataDir = path.resolve(process.cwd(), "data");
    const tmpDir = path.join(dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const tmpHtml = path.join(tmpDir, `fallback-${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, html, "utf-8");

    const imagesDir = path.join(dataDir, "generated-images");
    fs.mkdirSync(imagesDir, { recursive: true });

    const id = `fallback-${Date.now()}.png`;
    const outFile = path.join(imagesDir, id);

    log.info("Running browser image fallback", { sessionId: input.sessionId, shape, outFile });

    await executeTool(
      "browser_navigate",
      { url: `file://${tmpHtml}` },
      {} as never,
      { sessionId: input.sessionId || "browser-fallback", agentId: "", workspacePath: dataDir } as never,
    );

    await new Promise((r) => setTimeout(r, 1500));

    await executeTool(
      "browser_screenshot",
      {
        output_path: outFile,
        fullPage: true,
        fileType: "png",
      },
      {} as never,
      { sessionId: input.sessionId || "browser-fallback", agentId: "", workspacePath: dataDir } as never,
    );

    try { fs.unlinkSync(tmpHtml); } catch { /* ok */ }

    const fileExists = fs.existsSync(outFile);
    const fileSize = fileExists ? fs.statSync(outFile).size : 0;

    if (!fileExists || fileSize === 0) {
      return { ok: false, error: "Browser screenshot did not produce a valid file" };
    }

    return {
      ok: true,
      file: outFile,
      markdown: [
        "## Browser-Rendered Image",
        "",
        subject
          ? `Requested: ${subject} → rendered ${width}x${height}px browser fallback.`
          : `No native AI image-generation provider is configured (e.g., FAL, OpenAI DALL-E, or xAI). I rendered a deterministic HTML/CSC visual instead and saved it as a PNG artifact.`,
        "",
        `![Browser-rendered image](/api/generated-images?id=${id})`,
        "",
        `[Open image](/api/generated-images?id=${id})`,
        "",
        `**Dimensions:** ${width}x${height}px · **Format:** PNG · **Source:** browser fallback`,
        parsed.aspectSource ? `**Aspect:** ${parsed.aspectSource}` : null,
        "",
        "**What this is:** A browser-rendered placeholder image — not AI-generated art. It uses a pre-built HTML template captured via headless browser screenshot.",
        "",
        "**What this is not:** This is not native AI image generation. It cannot create photorealistic images, illustrations from prompts, or custom artwork.",
        "",
        "**To enable real image generation:** Add an API key for a supported provider in Settings → Models. Supported providers: FAL (fal.ai), OpenAI (DALL-E), or xAI (Grok). The app will automatically use the configured provider for future image requests.",
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    log.warn("Browser image fallback failed", { sessionId: input.sessionId, error: String(err) });
    return { ok: false, error: String(err) };
  }
}

function parseRequestedDimensions(prompt: string, fallbackShape: string): {
  width: number;
  height: number;
  shape: string;
  subject: string | null;
  aspectSource: string | null;
} {
  // Parse explicit aspect ratio (e.g., "16:9", "4:3", "1:1")
  const aspectMatch = prompt.match(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/);
  // Parse explicit dimensions (e.g., "1920x1080", "800x600")
  const dimMatch = prompt.match(/\b(\d{2,4})\s*x\s*(\d{2,4})\b/i);
  // Parse shape keywords
  const isPortrait = /\bportrait\b/i.test(prompt) || /\btall\b/i.test(prompt) || /\bposter\b/i.test(prompt);
  const isLandscape = /\blandscape\b/i.test(prompt) || /\bwide\b/i.test(prompt) || /\bbanner\b/i.test(prompt) || /\bhero\b/i.test(prompt);
  const isSquare = /\bsquare\b/i.test(prompt);
  const isIcon = /\bicon\b/i.test(prompt);

  let width: number;
  let height: number;
  let shape: string;
  let aspectSource: string | null = null;

  if (dimMatch) {
    width = Math.min(Math.max(parseInt(dimMatch[1]), 200), 1920);
    height = Math.min(Math.max(parseInt(dimMatch[2]), 200), 1920);
    shape = `${width}x${height}`;
    aspectSource = `parsed ${dimMatch[1]}x${dimMatch[2]} from prompt`;
  } else if (aspectMatch) {
    const aw = parseInt(aspectMatch[1]);
    const ah = parseInt(aspectMatch[2]);
    // Scale to reasonable pixel dimensions
    const scale = 800 / Math.max(aw, ah);
    width = Math.round(aw * scale);
    height = Math.round(ah * scale);
    shape = `${aw}:${ah}`;
    aspectSource = `parsed ${aspectMatch[1]}:${aspectMatch[2]} aspect from prompt`;
  } else if (isPortrait) {
    width = 600;
    height = 800;
    shape = "portrait";
    aspectSource = null;
  } else if (isLandscape) {
    width = 1200;
    height = 630;
    shape = "landscape";
    aspectSource = null;
  } else if (isSquare) {
    width = 800;
    height = 800;
    shape = "square";
    aspectSource = null;
  } else if (isIcon) {
    width = 256;
    height = 256;
    shape = "icon";
    aspectSource = null;
  } else {
    // Use fallback shape from caller
    switch (fallbackShape) {
      case "portrait": width = 600; height = 800; shape = "portrait"; break;
      case "landscape": width = 1200; height = 630; shape = "landscape"; break;
      default: width = 800; height = 800; shape = "square"; break;
    }
    aspectSource = null;
  }

  // Extract subject from prompt (rough heuristic)
  let subject: string | null = null;
  const subjectMatch = prompt.match(/\b(?:of|depicting|showing|featuring)\s+(?:a\s+)?(.{5,80}?)(?:\s*\.|\s*$)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  } else {
    // Try to extract from "image of X" or "picture of X"
    const altMatch = prompt.match(/\b(?:image|picture|portrait|photo|render|mockup|visual)\s+(?:of|for)\s+(?:a\s+)?(.{5,80}?)(?:\s*\.|\s*$)/i);
    if (altMatch) subject = altMatch[1].trim();
  }

  return { width, height, shape, subject, aspectSource };
}

function buildPlaceholderHtml(shape: string, prompt: string, width: number, height: number): string {
  const layoutShape = height > width ? "portrait" : width > height ? "landscape" : "square";

  const title = inferVisualTitle(prompt);
  const subtitle = inferVisualSubtitle(prompt);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${width}px; height: ${height}px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f6f1e8;
      color: #1f2933;
      display: flex; align-items: stretch; justify-content: center;
      overflow: hidden;
    }
    .frame {
      width: 100%;
      height: 100%;
      padding: ${layoutShape === "portrait" ? 34 : 42}px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 22px;
      background:
        radial-gradient(circle at 16% 18%, rgba(28, 108, 115, 0.15), transparent 28%),
        linear-gradient(135deg, #fbf7ef 0%, #ece7dc 100%);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      letter-spacing: 0;
      color: #5b6770;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      color: #263238;
    }
    .mark {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: #1c6c73;
      display: grid;
      place-items: center;
      color: #f8fafc;
      font-weight: 800;
    }
    .workspace {
      min-height: 0;
      display: grid;
      grid-template-columns: ${layoutShape === "portrait" ? "1fr" : "0.9fr 1.3fr"};
      gap: 18px;
      align-content: center;
    }
    .panel {
      border: 1px solid rgba(31, 41, 51, 0.16);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.74);
      box-shadow: 0 18px 50px rgba(37, 47, 57, 0.12);
      overflow: hidden;
    }
    .panel-header {
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      border-bottom: 1px solid rgba(31, 41, 51, 0.1);
      font-size: 13px;
      font-weight: 700;
      color: #25313a;
    }
    .dots { display: flex; gap: 6px; }
    .dots span {
      width: 7px; height: 7px; border-radius: 50%; background: #9aa5ad;
    }
    .canvas {
      padding: 20px;
      display: grid;
      gap: 14px;
    }
    .node {
      height: ${layoutShape === "portrait" ? 62 : 54}px;
      border-radius: 8px;
      border: 1px solid rgba(28, 108, 115, 0.28);
      background: #ffffff;
      display: grid;
      grid-template-columns: 42px 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 0 14px;
    }
    .icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: #e8f2f1;
      display: grid; place-items: center;
      color: #1c6c73;
      font-weight: 800;
    }
    .line1 { height: 10px; width: 78%; border-radius: 20px; background: #25313a; opacity: 0.72; }
    .line2 { height: 8px; width: 52%; border-radius: 20px; background: #6f7b83; opacity: 0.32; margin-top: 8px; }
    .pill {
      padding: 6px 10px;
      border-radius: 999px;
      background: #f0b85a;
      font-size: 11px;
      font-weight: 700;
      color: #3a2a0a;
    }
    .preview {
      padding: 22px;
      display: grid;
      align-content: center;
      gap: 18px;
      min-height: ${layoutShape === "portrait" ? 250 : 360}px;
      background:
        linear-gradient(180deg, rgba(28, 108, 115, 0.08), transparent),
        rgba(255,255,255,0.7);
    }
    h1 {
      max-width: 780px;
      font-size: ${layoutShape === "portrait" ? 43 : 52}px;
      line-height: 1.02;
      letter-spacing: 0;
      color: #1f2933;
      font-weight: 800;
    }
    .subtitle {
      max-width: 640px;
      font-size: ${layoutShape === "portrait" ? 17 : 19}px;
      line-height: 1.45;
      color: #52616b;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .metric {
      border-radius: 8px;
      background: #fff;
      border: 1px solid rgba(31, 41, 51, 0.12);
      padding: 12px;
    }
    .metric strong {
      display: block;
      font-size: 20px;
      color: #1c6c73;
    }
    .metric span {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: #6f7b83;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #6f7b83;
      font-size: 12px;
    }
    .caption {
      max-width: 70%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @media (max-width: 700px) {
      h1 { font-size: 38px; }
      .metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="frame">
    <div class="topbar">
      <div class="brand"><div class="mark">C</div><span>disp8ch AI Workspace</span></div>
      <div>${escapeHtml(shape)}</div>
    </div>
    <div class="workspace">
      <div class="panel">
        <div class="panel-header"><span>Agent Flow</span><div class="dots"><span></span><span></span><span></span></div></div>
        <div class="canvas">
          <div class="node"><div class="icon">1</div><div><div class="line1"></div><div class="line2"></div></div><div class="pill">input</div></div>
          <div class="node"><div class="icon">2</div><div><div class="line1"></div><div class="line2"></div></div><div class="pill">tools</div></div>
          <div class="node"><div class="icon">3</div><div><div class="line1"></div><div class="line2"></div></div><div class="pill">final</div></div>
        </div>
      </div>
      <div class="panel preview">
        <h1>${escapeHtml(title)}</h1>
        <div class="subtitle">${escapeHtml(subtitle)}</div>
        <div class="metrics">
          <div class="metric"><strong>3</strong><span>active lanes</span></div>
          <div class="metric"><strong>12</strong><span>tool events</span></div>
          <div class="metric"><strong>OK</strong><span>fallback render</span></div>
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="caption">${escapeHtml(prompt.slice(0, 180))}</div>
      <div>PNG via browser fallback</div>
    </div>
  </div>
</body>
</html>`;
}

function inferVisualTitle(prompt: string): string {
  if (/\bportrait\b/i.test(prompt) && /\bagent\s+workspace\b/i.test(prompt)) return "Minimal Agent Workspace";
  if (/\bworkflow\b/i.test(prompt)) return "Workflow Builder Dashboard";
  if (/\bdashboard\b/i.test(prompt)) return "AI Dashboard Mockup";
  if (/\bhero\b/i.test(prompt)) return "Product Hero Mockup";
  return "AI Workflow Visual";
}

function inferVisualSubtitle(prompt: string): string {
  if (/\bminimal\b/i.test(prompt)) return "A focused operator surface with agent steps, tool status, and final-output readiness.";
  if (/\bportrait\b/i.test(prompt)) return "A tall composition designed for a usable portrait-format artifact.";
  return "A deterministic browser-rendered artifact based on the requested visual brief.";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
