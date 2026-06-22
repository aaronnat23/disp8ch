import fs from "node:fs";
import path from "node:path";
import type { DesktopReleaseArtifact, DesktopReleaseManifest } from "./desktop-release-manifest";

type PackageManagerOptions = {
  manifestPath: string;
  outDir: string;
};

function parseArgs(argv: string[]): PackageManagerOptions {
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    manifestPath: path.resolve(valueAfter("--manifest") || path.join(process.cwd(), "dist", "desktop", "disp8ch-release-manifest.json")),
    outDir: path.resolve(valueAfter("--out") || path.join(process.cwd(), "dist", "desktop", "package-managers")),
  };
}

function readReleaseManifest(manifestPath: string): DesktopReleaseManifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DesktopReleaseManifest;
}

function optionalArtifact(
  manifest: DesktopReleaseManifest,
  predicate: (artifact: DesktopReleaseArtifact) => boolean,
  label: string,
): DesktopReleaseArtifact | null {
  const artifact = manifest.artifacts.find(predicate);
  if (!artifact) return null;
  if (!artifact.url) throw new Error(`${label} artifact is missing a public URL; run desktop:manifest with RELEASE_BASE_URL or --base-url`);
  return artifact;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function buildWingetManifests(manifest: DesktopReleaseManifest): Record<string, string> {
  const installer = optionalArtifact(
    manifest,
    (artifact) => artifact.platform === "win32" && artifact.type === "nsis" && artifact.arch === "x64",
    "Windows NSIS x64",
  );
  if (!installer) return {};
  const version = manifest.version;
  return {
    [`winget/disp8ch AI/disp8ch AI/${version}/disp8ch AI.disp8ch AI.yaml`]: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.9.0.schema.json",
      "PackageIdentifier: disp8ch AI.disp8ch AI",
      `PackageVersion: ${version}`,
      "DefaultLocale: en-US",
      "ManifestType: version",
      "ManifestVersion: 1.9.0",
      "",
    ].join("\n"),
    [`winget/disp8ch AI/disp8ch AI/${version}/disp8ch AI.disp8ch AI.installer.yaml`]: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.9.0.schema.json",
      "PackageIdentifier: disp8ch AI.disp8ch AI",
      `PackageVersion: ${version}`,
      "InstallerType: nullsoft",
      "Scope: user",
      "InstallModes:",
      "  - interactive",
      "  - silent",
      "InstallerSwitches:",
      "  Silent: /S",
      "  SilentWithProgress: /S",
      "UpgradeBehavior: install",
      "ReleaseDate: " + manifest.generatedAt.slice(0, 10),
      "Installers:",
      "  - Architecture: x64",
      `    InstallerUrl: ${installer.url}`,
      `    InstallerSha256: ${installer.sha256.toUpperCase()}`,
      "ManifestType: installer",
      "ManifestVersion: 1.9.0",
      "",
    ].join("\n"),
    [`winget/disp8ch AI/disp8ch AI/${version}/disp8ch AI.disp8ch AI.locale.en-US.yaml`]: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.9.0.schema.json",
      "PackageIdentifier: disp8ch AI.disp8ch AI",
      `PackageVersion: ${version}`,
      "PackageLocale: en-US",
      "Publisher: disp8ch AI",
      "PublisherUrl: https://disp8ch.app",
      "PackageName: disp8ch AI",
      "PackageUrl: https://disp8ch.app",
      "License: Proprietary",
      "ShortDescription: Local-first agent workspace with webchat, workflows, memory, skills, and desktop packaging.",
      "Tags:",
      "  - ai",
      "  - agent",
      "  - automation",
      "  - local-first",
      "ManifestType: defaultLocale",
      "ManifestVersion: 1.9.0",
      "",
    ].join("\n"),
  };
}

export function buildHomebrewCask(manifest: DesktopReleaseManifest): Record<string, string> {
  const dmg = optionalArtifact(
    manifest,
    (artifact) => artifact.platform === "darwin" && artifact.type === "dmg" && (artifact.arch === "arm64" || artifact.arch === "x64" || artifact.arch === "universal"),
    "macOS DMG",
  );
  if (!dmg) return {};
  return {
    "homebrew/Casks/disp8ch.rb": [
      'cask "disp8ch" do',
      `  version ${yamlString(manifest.version)}`,
      `  sha256 ${yamlString(dmg.sha256)}`,
      "",
      `  url ${yamlString(dmg.url ?? "")}`,
      '  name "disp8ch AI"',
      '  desc "Local-first agent workspace with webchat, workflows, memory, skills, and desktop packaging"',
      '  homepage "https://disp8ch.app"',
      "",
      '  app "disp8ch AI.app"',
      "",
      "  zap trash: [",
      '    "~/Library/Application Support/disp8ch AI",',
      '    "~/Library/Logs/disp8ch AI",',
      "  ]",
      "end",
      "",
    ].join("\n"),
  };
}

export function buildPackageManagerManifests(manifest: DesktopReleaseManifest): Record<string, string> {
  const generated = {
    ...buildWingetManifests(manifest),
    ...buildHomebrewCask(manifest),
  };
  const generatedKinds = [
    Object.keys(generated).some((file) => file.startsWith("winget/")) ? "- winget metadata generated from the Windows NSIS artifact." : "- winget metadata skipped because no Windows NSIS artifact was present.",
    Object.keys(generated).some((file) => file.startsWith("homebrew/")) ? "- Homebrew Cask generated from the macOS DMG artifact." : "- Homebrew Cask skipped because no macOS DMG artifact was present.",
  ];
  return {
    ...generated,
    "README.md": [
      "# Package Manager Manifests",
      "",
      "Generated from `disp8ch-release-manifest.json`.",
      "",
      ...generatedKinds,
      "",
      "These files still require normal upstream review/publication and signed release artifacts before users should install from package managers.",
      "",
    ].join("\n"),
  };
}

export function writePackageManagerManifests(options: PackageManagerOptions): string[] {
  const manifest = readReleaseManifest(options.manifestPath);
  const files = buildPackageManagerManifests(manifest);
  const written: string[] = [];
  fs.rmSync(options.outDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(options.outDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    written.push(full);
  }
  return written;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const written = writePackageManagerManifests(options);
  console.log(`package-manager-manifests: wrote ${written.length} file(s) to ${options.outDir}`);
}

if (process.argv[1] && path.parse(process.argv[1]).name === "package-manager-manifests") {
  main();
}
