import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { getDesignArtifactById } from "@/lib/design-studio/store";
import { jsonError, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

async function renderArtifactExport(html: string, format: "png" | "pdf") {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    if (format === "pdf") {
      return await page.pdf({ printBackground: true, format: "A4" });
    }
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await browser.close();
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifact = getDesignArtifactById(safeDesignIdFromParams(ctx.params));
    if (!artifact) return jsonError("Design artifact not found", 404);
    const body = await req.json().catch(() => ({}));
    const queryFormat = req.nextUrl.searchParams.get("format");
    const format = String(body.format || queryFormat || "html").toLowerCase();
    const safeName = artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";

    if (format === "summary") {
      const md = [
        `# ${artifact.title}`,
        "",
        `Project: ${artifact.project?.name || artifact.projectId}`,
        `Artifact: ${artifact.id}`,
        `Current version: v${artifact.currentVersionNumber ?? "?"}`,
        `Validation: ${artifact.validation.errors.length} errors, ${artifact.validation.warnings.length} warnings`,
      ].join("\n");
      return new NextResponse(md, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${safeName}-summary.md"`,
        },
      });
    }

    if (format === "zip") {
      const zip = new JSZip();
      zip.file("index.html", artifact.currentSource);
      zip.file("README.md", `# ${artifact.title}\n\nExported from disp8ch AI Design Studio.\n`);
      zip.file("handoff.md", [
        `# ${artifact.title}`,
        "",
        `Project: ${artifact.project?.name || artifact.projectId}`,
        `Version: v${artifact.currentVersionNumber ?? "?"}`,
        "",
        "## Validation",
        `Errors: ${artifact.validation.errors.length}`,
        `Warnings: ${artifact.validation.warnings.length}`,
      ].join("\n"));
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${safeName}.zip"`,
        },
      });
    }

    if (format === "png" || format === "pdf") {
      const buffer = await renderArtifactExport(artifact.currentSource, format);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "content-type": format === "png" ? "image/png" : "application/pdf",
          "content-disposition": `attachment; filename="${safeName}.${format}"`,
        },
      });
    }

    return new NextResponse(artifact.currentSource, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}.html"`,
      },
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  return POST(req, ctx);
}
