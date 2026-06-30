#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const { applyDesignPatch } = await import("../src/lib/design-studio/patches");
  const source = `<!doctype html><html><body><div data-disp8ch-id="outer"><div data-disp8ch-id="inner"><span data-disp8ch-id="title">Hello</span></div></div><img data-disp8ch-id="hero-image" src="old.png" alt="old"></body></html>`;

  console.log("\n[1] Element style patches preserve nested markup");
  const styled = applyDesignPatch(source, {
    kind: "set-style",
    id: "outer",
    styles: { position: "relative", left: "12px", width: "640px", "background-color": "#121212" },
  });
  check("position written to selected opening tag", /data-disp8ch-id="outer"[^>]*style="[^"]*position: relative/.test(styled), styled);
  check("nested target remains intact", styled.includes('data-disp8ch-id="inner"') && styled.includes('data-disp8ch-id="title"'));
  check("style patch does not duplicate target", (styled.match(/data-disp8ch-id="outer"/g) || []).length === 1);

  console.log("\n[2] Void image targets are editable");
  const image = applyDesignPatch(styled, { kind: "set-image", id: "hero-image", src: "new.png", alt: "New hero" });
  check("image src updated", image.includes('src="new.png"'));
  check("image alt updated", image.includes('alt="New hero"'));

  console.log("\n[3] Inspector exposes real visual controls");
  const inspector = fs.readFileSync(path.join(process.cwd(), "src/components/design-studio/manual/StyleInspector.tsx"), "utf8");
  for (const label of ["Layout & position", "Typography", "Spacing", "Fill, border & effects", "Flex & grid"]) {
    check(`${label} controls exist`, inspector.includes(label));
  }
  for (const property of ["font-size", "background-color", "border-radius", "padding-left", "grid-template-columns", "opacity"]) {
    check(`${property} is editable`, inspector.includes(`css: "${property}"`));
  }
  check("inspector applies one structured patch", inspector.includes('kind: "set-style"') && inspector.includes("Object.fromEntries(Array.from(dirty)"));

  console.log("\n[4] Preview bridge returns computed style and geometry safely");
  const bridge = fs.readFileSync(path.join(process.cwd(), "src/components/design-studio/preview/edit-bridge.ts"), "utf8");
  check("bridge captures computed style", bridge.includes("getComputedStyle(el)"));
  check("bridge captures bounds", bridge.includes("getBoundingClientRect()"));
  check("bridge captures parent hierarchy", bridge.includes("parentId"));
  check("edit clicks cannot navigate artifact links", bridge.includes("event.preventDefault()") && bridge.includes("event.stopPropagation()"));
  const frame = fs.readFileSync(path.join(process.cwd(), "src/components/design-studio/DesignPreviewFrame.tsx"), "utf8");
  check("host accepts messages only from its preview frame", frame.includes("event.source !== iframeRef.current?.contentWindow"));

  console.log(`\ndesign-studio-element-editor: ${passed}/${passed + failed} passed`);
  if (failed) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
