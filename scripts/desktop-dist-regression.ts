import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync("scripts/desktop-dist.ts", "utf8");
const exportScript = fs.readFileSync("scripts/export-public-release.mjs", "utf8");
assert(script.includes('filter((arg) => arg !== "--")'), "desktop-dist must strip pnpm's -- separator");
assert(script.includes('"electron-builder", ...passthroughArgs'), "desktop-dist must pass platform args to electron-builder");
assert(script.includes('"desktop:standalone-build"'), "desktop-dist must build Next in standalone mode before staging");
assert(script.includes('"desktop:manifest"'), "desktop-dist must run release manifest after electron-builder");
assert(script.includes('shell: process.platform === "win32"'), "desktop-dist must use shell mode for Windows .cmd shims");
assert(script.includes("restorePackageInstallIfBuilderMutatedIt"), "desktop-dist must repair pnpm install if electron-builder mutates package contents");
assert(script.includes('"install", "--force"'), "desktop-dist repair must force pnpm install when package integrity is broken");
assert(script.includes('"_app.js"'), "desktop-dist integrity check must cover Next dev-server page files");
assert(script.includes('"server", "next.js"'), "desktop-dist integrity check must cover Next server files");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
assert.equal(pkg.scripts?.["desktop:dist"], "tsx scripts/desktop-dist.ts");
assert.equal(pkg.scripts?.["desktop:standalone-build"], "tsx scripts/desktop-standalone-build.ts");
assert(exportScript.includes('"desktop:standalone-build": parsed.scripts?.["desktop:standalone-build"]'), "public export must retain the standalone build command");
assert(exportScript.includes('"desktop-standalone-build.ts"'), "public export must include the standalone build helper");
for (const scriptName of [
  "desktop-hardening-regression.ts",
  "attention-center-regression.ts",
  "command-palette-shortcuts-regression.ts",
  "work-monitor-regression.ts",
  "pty-policy-regression.ts",
  "desktop-prefs-regression.ts",
  "deeplink-regression.ts",
]) {
  assert(exportScript.includes(`"${scriptName}"`), `public release tests must include ${scriptName}`);
}

console.log("desktop-dist-regression: ok");
