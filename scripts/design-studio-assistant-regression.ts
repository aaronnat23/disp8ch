#!/usr/bin/env tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-design-assistant-"));
process.env.DATABASE_PATH = path.join(tempRoot, "design-assistant.db");
process.env.WORKSPACE_PATH = path.join(tempRoot, "workspace");
process.env.MEMORY_PATH = path.join(tempRoot, "memory");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function main() {
  const { initializeDatabase, getSqlite } = await import("../src/lib/db");
  const store = await import("../src/lib/design-studio/store");
  const { buildDesignAssistantMessage, resolveDesignAssistantSessionId } = await import("../src/lib/design-studio/assistant-context");
  const { classifyWebChatIntent } = await import("../src/lib/channels/webchat-intent");
  initializeDatabase();

  console.log("\n[1] Originating WebChat sessions survive design storage");
  const sourceSessionId = "webchat-design-origin";
  const project = store.createDesignProject({ name: "Assistant Regression", sourceSessionId });
  const artifact = store.createDesignArtifact({
    projectId: project.id,
    title: "Scoped Landing Page",
    sourceSessionId,
    html: '<!doctype html><html><body><main data-disp8ch-id="page"><h1 data-disp8ch-id="hero-title">Original</h1></main></body></html>',
  });
  check("project exposes its source session", project.sourceSessionId === sourceSessionId, String(project.sourceSessionId));
  check("artifact exposes its source session", artifact.sourceSessionId === sourceSessionId, String(artifact.sourceSessionId));
  check("artifact session wins continuity resolution", resolveDesignAssistantSessionId({ projectId: project.id, projectSourceSessionId: "other", artifactSourceSessionId: sourceSessionId }, "fallback") === sourceSessionId);
  check("manual project receives stable design session", resolveDesignAssistantSessionId({ projectId: "desproj_manual", projectSourceSessionId: null, artifactSourceSessionId: null }, "fallback") === "design-desproj_manual");
  check("empty workspace receives bounded draft session", resolveDesignAssistantSessionId({ projectId: null, projectSourceSessionId: null, artifactSourceSessionId: null }, "unsafe token !") === "design-draft-unsafetoken");

  console.log("\n[2] Revision context binds the exact artifact and selected element");
  const revision = buildDesignAssistantMessage("Make this heading red and move it down slightly.", {
    mode: "revise",
    projectId: project.id,
    projectName: project.name,
    projectSourceSessionId: sourceSessionId,
    artifactId: artifact.id,
    artifactTitle: artifact.title,
    artifactVersion: artifact.currentVersionNumber,
    artifactSourceSessionId: sourceSessionId,
    selectedTarget: {
      id: "hero-title",
      label: "Hero title",
      tag: "h1",
      text: "Original",
      parentId: "page",
      bounds: { x: 20, y: 30, width: 400, height: 60 },
      styles: { color: "rgb(255, 255, 255)", "font-size": "48px", position: "static" },
    },
  });
  check("prompt identifies Design Studio", revision.includes("In Design Studio"));
  check("prompt binds exact artifact id", revision.includes(artifact.id));
  check("prompt keeps the existing artifact as write target", revision.includes("Keep this artifact as the write target"));
  check("prompt scopes exact element id", revision.includes("hero-title") && revision.includes("Scope the requested change"));
  check("prompt retains clean user request", revision.endsWith("Make this heading red and move it down slightly."));

  console.log("\n[3] Creation context targets an existing project");
  const creation = buildDesignAssistantMessage("Create a compact operations dashboard.", {
    mode: "create",
    projectId: project.id,
    projectName: project.name,
    artifactId: null,
    artifactTitle: null,
    artifactVersion: null,
    recipeId: "dashboard",
    recipeLabel: "Dashboard",
    designSystemId: "builtin:disp8ch-terminal",
    designSystemName: "Terminal",
  });
  check("create targets current project", creation.includes(`existing Design Studio project with id ${project.id}`));
  check("create includes recipe and system", creation.includes("dashboard") && creation.includes("builtin:disp8ch-terminal"));
  let rejectedEmpty = false;
  try { buildDesignAssistantMessage("  ", { mode: "create", projectId: null, projectName: null, artifactId: null, artifactTitle: null, artifactVersion: null }); } catch { rejectedEmpty = true; }
  check("empty requests are rejected", rejectedEmpty);
  const reviseIntent = classifyWebChatIntent("Design Studio: Change only the selected heading text.", { sessionId: sourceSessionId });
  check("surface-scoped revision is classified as a mutation", reviseIntent.kind === "app-mutation-proposal" && reviseIntent.surface === "designs");

  console.log("\n[4] UI and channel route use one shared chat backend");
  const shell = fs.readFileSync(path.join(process.cwd(), "src/components/design-studio/DesignStudioShell.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(process.cwd(), "src/components/chat/surface-assistant-panel.tsx"), "utf8");
  const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/channels/route.ts"), "utf8");
  const manual = fs.readFileSync(path.join(process.cwd(), "src/components/design-studio/manual/ManualEditPanel.tsx"), "utf8");
  const handoff = fs.readFileSync(path.join(process.cwd(), "src/components/app/webchat-draft-button.tsx"), "utf8");
  check("Design Studio embeds shared assistant panel", shell.includes("<SurfaceAssistantPanel") && shell.includes("assistantSessionId"));
  check("old redirect handoff removed", !shell.includes("window.location.href = `/chat?draft="));
  check("panel sends through canonical channels API", panel.includes('fetch("/api/channels"') && panel.includes('action: "chat"'));
  check("panel preserves clean display message", panel.includes("displayMessage") && route.includes("content: displayMessage"));
  check("routing uses separate surface context while the model gets attached context", route.includes("const rawMessage = routingMessage") && route.includes("const routedMessage = String(message)"));
  check("Design Studio supplies non-displayed routing context", shell.includes('routingContext="Design Studio"') && panel.includes("routingMessage"));
  check("explicit surface mutations bypass the memory fast lane", route.includes("!isProtectedBuiltin && intent.readOnly && !isCrossSurfaceAppMutationRequest(rawMessage)") && route.includes("intent.readOnly && !isCrossSurfaceAppMutationRequest(rawMessage)"));
  check("agentic execution receives attached surface context", route.includes("const agenticResult = await runAgenticTurn({\n              message: routedMessage"));
  check("selected-element comment focuses AI composer", manual.includes("Ask AI about") && shell.includes('getElementById("design-ai-composer")'));
  check("full chat and generic handoffs preserve return path", panel.includes("returnTo") && handoff.includes('query.set("returnTo"'));
  check("Design Studio consumes project/artifact deep links", shell.includes('searchParams.get("project")') && shell.includes('searchParams.get("artifact")'));

  console.log(`\ndesign-studio-assistant-regression: ${passed}/${passed + failed} passed`);
  getSqlite().close();
  if (failed) {
    console.error(`Failures: ${failures.join(", ")}`);
    throw new Error("Design Studio assistant regression failed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
