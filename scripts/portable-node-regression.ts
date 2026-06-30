import assert from "node:assert/strict";
import {
  buildNodeArchivePattern,
  currentNodeSatisfies,
  latestNodeIndexUrl,
  resolvePortableNodeTarget,
} from "./portable-node";

assert.equal(currentNodeSatisfies("v22.12.0"), false);
assert.equal(currentNodeSatisfies("v22.13.0"), true);
assert.equal(currentNodeSatisfies("v22.22.3"), true);
assert.equal(currentNodeSatisfies("v23.0.0"), true);
assert.equal(currentNodeSatisfies("v21.99.99"), false);

const win = resolvePortableNodeTarget("win32", "x64");
assert.equal(win.archiveExt, ".zip");
assert.equal(win.nodePlatform, "win");
assert.equal(win.nodeArch, "x64");

const macArm = resolvePortableNodeTarget("darwin", "arm64");
assert.equal(macArm.archiveExt, ".tar.xz");
assert.equal(macArm.nodePlatform, "darwin");
assert.equal(macArm.nodeArch, "arm64");

const linuxPattern = buildNodeArchivePattern(resolvePortableNodeTarget("linux", "x64"));
assert(linuxPattern.test("node-v22.22.3-linux-x64.tar.xz"));
assert(!linuxPattern.test("node-v20.11.1-linux-x64.tar.xz"));
assert.equal(latestNodeIndexUrl(), "https://nodejs.org/dist/latest-v22.x/");

console.log("portable-node-regression: ok");
