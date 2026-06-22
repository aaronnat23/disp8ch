import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodeEditDossier } from "@/lib/channels/code-edit-dossier";
import type { VerificationContract } from "@/lib/channels/code-edit-verification-contract";

const execFileAsync = promisify(execFile);

export type RuntimeManagedProbeResult = {
  ran: boolean;
  command: string;
  ok: boolean;
  output: string;
  tempFile?: string;
};

function hasProbe(contract: VerificationContract, id: string): boolean {
  return contract.probes.some((probe) => probe.id === id);
}

function isSafeRelativePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return Boolean(normalized) &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").includes("..");
}

async function findStringTransformExport(absFile: string): Promise<string | null> {
  const content = await fs.readFile(absFile, "utf8");
  const match = content.match(/\bexport\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\s*:\s*string\s*\)\s*:\s*string\b/);
  return match?.[1] ?? null;
}

function buildStringTransformCases(contract: VerificationContract): Array<[string, string]> {
  const cases: Array<[string, string]> = [];
  if (hasProbe(contract, "edge_whitespace_before_trailing_punctuation")) {
    cases.push(["  the API guide  !", "The API Guide"]);
  } else if (hasProbe(contract, "edge_whitespace")) {
    cases.push(["  the API   guide  ", "The API Guide"]);
  }
  if (hasProbe(contract, "edge_uppercase_connector_normalization")) {
    cases.push(["NASA AND THE API guide", "NASA and the API Guide"]);
    cases.push(["WELCOME TO THE API GUIDE", "Welcome to the API Guide"]);
  } else if (hasProbe(contract, "edge_rule_precedence_overlap")) {
    cases.push(["NASA and the API guide", "NASA and the API Guide"]);
  }
  if (hasProbe(contract, "edge_punctuation") && !cases.some(([input]) => /[.!?]/.test(input))) {
    cases.push(["the API guide?", "The API Guide"]);
  }
  return Array.from(new Map(cases.map((item) => [item.join("\u0000"), item])).values()).slice(0, 6);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function buildProbeScript(exportName: string, importPath: string, cases: Array<[string, string]>): string {
  const caseLines = cases
    .map(([input, expected]) => `  [${jsString(input)}, ${jsString(expected)}],`)
    .join("\n");
  return [
    `import { ${exportName} } from ${jsString(importPath)};`,
    "",
    `const cases = [`,
    caseLines,
    `];`,
    "",
    "let failures = 0;",
    "for (const [input, expected] of cases) {",
    `  const actual = ${exportName}(input);`,
    "  if (actual !== expected) {",
    "    failures += 1;",
    "    console.log(`FAIL ${JSON.stringify(input)} => ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);",
    "  } else {",
    "    console.log(`PASS ${JSON.stringify(input)} => ${JSON.stringify(actual)}`);",
    "  }",
    "}",
    "console.log(`runtime-managed-code-probe: ${cases.length - failures}/${cases.length} passed`);",
    "if (failures > 0) process.exit(1);",
    "",
  ].join("\n");
}

export async function runRuntimeManagedCodeEditProbes(input: {
  codeEditDossier: CodeEditDossier;
  contract: VerificationContract;
  workspacePath?: string | null;
}): Promise<RuntimeManagedProbeResult> {
  const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : "";
  if (!workspacePath) return { ran: false, command: "", ok: false, output: "No workspace path available for runtime-managed code probes." };
  if (!input.contract.minimumEvidence.requiresBehaviorProbe) {
    return { ran: false, command: "", ok: false, output: "No behavior probe required by contract." };
  }
  const cases = buildStringTransformCases(input.contract);
  if (cases.length === 0) return { ran: false, command: "", ok: false, output: "No runtime-managed cases derived for this contract." };

  const candidate = input.codeEditDossier.changedFiles.find((file) =>
    /\.(?:ts|tsx|js|jsx|mjs)$/i.test(file) &&
    !/\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(file) &&
    isSafeRelativePath(file),
  );
  if (!candidate) return { ran: false, command: "", ok: false, output: "No supported changed JS/TS artifact found for runtime-managed probes." };

  const absFile = path.resolve(workspacePath, candidate);
  const relative = path.relative(workspacePath, absFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ran: false, command: "", ok: false, output: "Changed file resolved outside workspace." };
  }

  const exportName = await findStringTransformExport(absFile);
  if (!exportName) {
    return { ran: false, command: "", ok: false, output: `No exported string-to-string function found in ${candidate}.` };
  }

  const tempFile = path.join(workspacePath, `.disp8ch-runtime-code-probe-${Date.now().toString(36)}.ts`);
  const importPath = `./${candidate.replace(/\\/g, "/")}`;
  const script = buildProbeScript(exportName, importPath, cases);
  await fs.writeFile(tempFile, script, "utf8");

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const command = `${pnpm} exec tsx ${path.basename(tempFile)} # imports ${candidate}`;
  try {
    const result = await execFileAsync(pnpm, ["exec", "tsx", path.basename(tempFile)], {
      cwd: workspacePath,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 80_000,
    });
    await fs.rm(tempFile, { force: true });
    return {
      ran: true,
      command,
      ok: true,
      output: `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim() || "runtime-managed-code-probe: command passed with no output",
      tempFile: path.basename(tempFile),
    };
  } catch (error) {
    await fs.rm(tempFile, { force: true });
    const err = error as { stdout?: string; stderr?: string; code?: unknown; message?: string };
    return {
      ran: true,
      command,
      ok: false,
      output: [
        err.stdout || "",
        err.stderr || "",
        `Exit code: ${String(err.code ?? "unknown")}`,
        err.message ? `Error: ${err.message}` : "",
      ].filter(Boolean).join("\n").trim(),
      tempFile: path.basename(tempFile),
    };
  }
}
