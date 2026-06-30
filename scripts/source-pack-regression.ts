/**
 * Source-pack regression (temp DB + fixture folder, no model).
 *
 * Proves Phase 1 of the learn-from-sources plan:
 *  - a bounded folder walk extracts text-like files,
 *  - .env / .git / node_modules / binary / oversized files are ignored,
 *  - items and chunks are hashed and stored,
 *  - the manifest is deterministic (same folder → same hashes),
 *  - drift detection flags a changed source file.
 *
 * Run: pnpm exec tsx scripts/source-pack-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_source_pack_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "packs.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");
const ignoredSecret = ["sk", "should-never-be-ingested-123456"].join("-");

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

function buildFixture(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# API\n\nCall GET /v1/things to list things.\n");
  fs.writeFileSync(path.join(root, "client.ts"), "export function listThings() { return fetch('/v1/things'); }\n");
  fs.writeFileSync(path.join(root, "guide.html"), "<html><title>Guide</title><body><h1>Setup</h1><p>Set BASE_URL.</p></body></html>");
  // Sensitive + ignored files that must be skipped.
  const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const privateKeyFooter = ["-----END", "PRIVATE KEY-----"].join(" ");
  fs.writeFileSync(path.join(root, ".env"), `SECRET_KEY=${ignoredSecret}\n`);
  fs.writeFileSync(path.join(root, "private.pem"), `${privateKeyHeader}\nabc\n${privateKeyFooter}\n`);
  // Binary-ish file by extension.
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  // Ignored directories.
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  // Oversized text file.
  fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(600 * 1024));
}

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { buildSourcePackFromFolder, sourcePackContentHash } = await import("../src/lib/source-packs/build");
  const { listSourcePackItems, listSourcePackChunks } = await import("../src/lib/source-packs/store");
  const { checkSourcePackDrift } = await import("../src/lib/source-packs/provenance");

  initializeDatabase();
  const fixture = path.join(tmp, "api-docs");
  buildFixture(fixture);

  console.log("\n[1] Build pack from folder");
  const built = buildSourcePackFromFolder({ name: "API docs pack", folderPath: fixture });
  check("pack status indexed", built.pack.status === "indexed");
  check("added 3 usable files", built.added === 3, `got ${built.added}`);

  const items = listSourcePackItems(built.pack.id);
  const names = items.map((i) => path.basename(i.displayName));
  console.log("\n[2] Ignore rules");
  check("README.md ingested", names.includes("README.md"));
  check("client.ts ingested", names.includes("client.ts"));
  check("guide.html ingested", names.includes("guide.html"));
  check(".env NOT ingested", !names.includes(".env"));
  check("private.pem NOT ingested", !names.includes("private.pem"));
  check("logo.png NOT a usable item (binary)", !items.some((i) => path.basename(i.displayName) === "logo.png" && !i.skippedReason));
  check("node_modules NOT walked", !names.includes("index.js"));
  check(".git NOT walked", !names.some((n) => n === "config"));
  check("oversized huge.txt skipped", !items.some((i) => path.basename(i.displayName) === "huge.txt" && !i.skippedReason));

  console.log("\n[3] No secret content stored");
  const allText = JSON.stringify(items);
  check("no SECRET_KEY value leaked into pack", !allText.includes(ignoredSecret));

  console.log("\n[4] Hashes + chunks recorded");
  const usable = items.filter((i) => !i.skippedReason);
  check("every usable item has a sha256", usable.every((i) => i.sha256.length === 64));
  const chunks = listSourcePackChunks(built.pack.id);
  check("chunks recorded", chunks.length >= 3, `got ${chunks.length}`);
  check("every chunk has a sha256", chunks.every((c) => c.sha256.length === 64));

  console.log("\n[5] Deterministic manifest");
  const hashA = sourcePackContentHash(built.pack.id);
  const built2 = buildSourcePackFromFolder({ name: "API docs pack 2", folderPath: fixture });
  const hashB = sourcePackContentHash(built2.pack.id);
  check("same folder → same content hash", hashA === hashB, `${hashA.slice(0, 8)} vs ${hashB.slice(0, 8)}`);

  console.log("\n[6] Drift detection");
  const driftBefore = checkSourcePackDrift(built.pack.id);
  check("no drift before change", !driftBefore.drifted);
  fs.writeFileSync(path.join(fixture, "README.md"), "# API v2\n\nCall GET /v2/things now.\n");
  const driftAfter = checkSourcePackDrift(built.pack.id);
  check("drift detected after source change", driftAfter.drifted);
  check("changed item flagged", driftAfter.items.some((i) => path.basename(i.displayName) === "README.md" && i.state === "changed"));

  console.log(`\nsource-pack: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
