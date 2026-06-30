/**
 * Design Studio reference-vs-artifact classification regression (pure).
 *
 * Proves Phase 6 conversion rules:
 *  - imported images are references by default (with a convert action),
 *  - standalone HTML imports become editable artifacts directly,
 *  - React/Tailwind/source imports stay references until converted.
 *
 * Run: pnpm exec tsx scripts/design-studio-reference-conversion-regression.ts
 */
let passed = 0,
  failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
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
  const { classifyDesignImport } = await import("../src/lib/design-studio/generation-context");

  console.log("\n[1] Image is a reference by default");
  const img = classifyDesignImport({ mimeType: "image/png", fileName: "mockup.png" });
  check("image classified as reference", img.kind === "reference");
  check("image offers convert-to-HTML action", img.conversionAction === "Generate editable HTML from this image");

  console.log("\n[2] Standalone HTML is an artifact");
  const html = classifyDesignImport({
    fileName: "page.html",
    content: "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>",
  });
  check("standalone HTML classified as artifact", html.kind === "artifact");
  check("artifact has no conversion action", html.conversionAction === null);

  console.log("\n[3] React/Tailwind source is a reference until converted");
  const react = classifyDesignImport({
    fileName: "Component.tsx",
    content: "import React from 'react';\nexport default function C(){ return <div className='p-4'>x</div>; }",
  });
  check("react source classified as reference", react.kind === "reference");
  check("react offers convert-to-standalone action", react.conversionAction === "Convert source to standalone HTML");

  console.log("\n[4] Plain HTML fragment is a convertible reference");
  const frag = classifyDesignImport({ fileName: "snippet.html", content: "<section><h2>Part</h2></section>" });
  check("fragment is a reference", frag.kind === "reference");
  check("fragment offers conversion", Boolean(frag.conversionAction));

  console.log(`\ndesign-studio-reference-conversion: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
