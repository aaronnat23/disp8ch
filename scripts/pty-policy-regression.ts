#!/usr/bin/env tsx
/**
 * Phase 4 Developer Workspace PTY safety regression: workspace-boundary
 * enforcement, cwd resolution, shell defaults, and lifecycle teardown.
 */
import path from "node:path";
import {
  PtyRegistry,
  defaultShell,
  isWithinRoot,
  resolveStartCwd,
} from "../desktop/pty-policy";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const root = path.resolve("/work/space");

check("within.same", isWithinRoot(root, root));
check("within.child", isWithinRoot(path.join(root, "src/app"), root));
check("within.parentDenied", !isWithinRoot(path.resolve("/work"), root));
check("within.escapeDenied", !isWithinRoot(path.join(root, "..", "..", "etc"), root));
check("within.siblingDenied", !isWithinRoot(path.resolve("/work/other"), root));

check("cwd.defaultsToFirstRoot", resolveStartCwd(undefined, [root]).cwd === root);
check("cwd.noRoots", resolveStartCwd(undefined, []).ok === false);
check("cwd.requestedInside", resolveStartCwd(path.join(root, "pkg"), [root]).cwd === path.join(root, "pkg"));
check("cwd.requestedOutsideDenied", resolveStartCwd("/etc", [root]).ok === false);
check("cwd.outsideReason", resolveStartCwd("/etc", [root]).reason === "outside-trusted-roots");

const winShell = defaultShell("win32");
check("shell.win", /cmd|powershell/i.test(winShell.file));
const nixShell = defaultShell("linux");
check("shell.nix", nixShell.file.length > 0);

let killed = 0;
const registry = new PtyRegistry();
registry.add({ id: "a", kill: () => { killed += 1; } });
registry.add({ id: "b", kill: () => { killed += 1; } });
check("registry.tracks", registry.size === 2 && registry.has("a"));
registry.remove("a");
check("registry.removes", registry.size === 1 && !registry.has("a"));
registry.add({ id: "c", kill: () => { killed += 1; } });
registry.killAll();
check("registry.killAll", killed === 2 && registry.size === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\npty-policy-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
