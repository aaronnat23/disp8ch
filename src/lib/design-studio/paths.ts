import fs from "node:fs";
import path from "node:path";
import { assertCanonicalPathInsideRoot } from "@/lib/security/path-safety";

const SAFE_ID_RE = /^(?:desproj|desart|desver|despatch|dessys|desval|desasset)_[a-zA-Z0-9_-]{8,80}$/;

export function assertSafeDesignId(id: string): string {
  const value = String(id || "").trim();
  if (!SAFE_ID_RE.test(value)) {
    throw new Error("Invalid design id");
  }
  return value;
}

export function getDesignStudioRoot(): string {
  return path.resolve(process.cwd(), "data", "design-studio");
}

export function assertDesignPathSafe(absPath: string): string {
  return assertCanonicalPathInsideRoot(absPath, getDesignStudioRoot());
}

export function ensureDesignStudioRoot(): string {
  const root = getDesignStudioRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getDesignProjectDir(projectId: string): string {
  assertSafeDesignId(projectId);
  return path.join(ensureDesignStudioRoot(), "projects", projectId);
}

export function getDesignArtifactDir(projectId: string, artifactId: string): string {
  assertSafeDesignId(projectId);
  assertSafeDesignId(artifactId);
  return path.join(getDesignProjectDir(projectId), "artifacts", artifactId);
}

export function getDesignVersionPath(projectId: string, artifactId: string, versionNumber: number): string {
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new Error("Invalid design version number");
  }
  const filePath = path.join(
    getDesignArtifactDir(projectId, artifactId),
    "versions",
    `v${String(versionNumber).padStart(4, "0")}.html`,
  );
  assertDesignPathSafe(filePath);
  return filePath;
}

export function ensureDesignArtifactDirs(projectId: string, artifactId: string): void {
  const base = getDesignArtifactDir(projectId, artifactId);
  for (const dir of ["versions", "assets", "exports"]) {
    const abs = path.join(base, dir);
    assertDesignPathSafe(abs);
    fs.mkdirSync(abs, { recursive: true });
  }
}
