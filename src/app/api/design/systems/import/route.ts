import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { createDesignSystem } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi } from "@/lib/design-studio/api";

function trustedImportRoot(): string {
  return path.resolve(process.env.DESIGN_SYSTEM_IMPORT_ROOT || path.join(process.cwd(), "..", "design-system-import"));
}

export async function POST(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const mode = String(body.mode || "manual");
    if (mode === "manual") {
      const system = createDesignSystem({
        name: String(body.name || ""),
        category: body.category == null ? null : String(body.category),
        description: body.description == null ? null : String(body.description),
        designMd: String(body.designMd || ""),
        tokensCss: body.tokensCss == null ? null : String(body.tokensCss),
        componentsHtml: body.componentsHtml == null ? null : String(body.componentsHtml),
        source: { mode },
      });
      return jsonOk(system, { status: 201 });
    }

    const relative = String(body.path || "").replace(/\\/g, "/");
    if (!relative || relative.includes("..") || path.isAbsolute(relative)) {
      return jsonError("A safe relative design-system folder path is required", 400);
    }
    const root = trustedImportRoot();
    const folder = path.resolve(root, relative);
    if (!folder.startsWith(root + path.sep)) return jsonError("Import path is outside the trusted design-system folder", 400);
    const designMdPath = path.join(folder, "DESIGN.md");
    if (!fs.existsSync(designMdPath)) return jsonError("DESIGN.md not found in import folder", 404);
    const system = createDesignSystem({
      name: String(body.name || path.basename(folder)),
      category: body.category == null ? "imported" : String(body.category),
      description: body.description == null ? null : String(body.description),
      designMd: fs.readFileSync(designMdPath, "utf8"),
      tokensCss: fs.existsSync(path.join(folder, "tokens.css")) ? fs.readFileSync(path.join(folder, "tokens.css"), "utf8") : null,
      componentsHtml: fs.existsSync(path.join(folder, "components.html")) ? fs.readFileSync(path.join(folder, "components.html"), "utf8") : null,
      source: { mode, relativePath: relative },
    });
    return jsonOk(system, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
