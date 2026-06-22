import { spawnSync } from "node:child_process";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

function getGitDiffStatus() {
  const result = spawnSync("git", ["status", "--short"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return {
      gitRepo: false,
      modifiedFiles: 0,
      sample: [] as string[],
    };
  }

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    gitRepo: true,
    modifiedFiles: lines.length,
    sample: lines.slice(0, 5),
  };
}

const diffsRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const preferredLayout = String(context.config.preferredLayout || "unified");
    return [
      "Diff guidance:",
      "- Prefer before/after or patch-style reasoning when reviewing code changes.",
      `- Default to ${preferredLayout} layout when presenting diffs unless the user asks for another format.`,
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+diffs\s+extension\s+status$/i.test(message.trim())) return null;
    const status = getGitDiffStatus();
    return [
      "Diffs",
      `Git repo: ${status.gitRepo ? "yes" : "no"}`,
      `Modified files: ${status.modifiedFiles}`,
      `Sample: ${status.sample.join(", ") || "none"}`,
    ].join("\n");
  },
  getStatus() {
    return getGitDiffStatus();
  },
};

export default diffsRuntime;
