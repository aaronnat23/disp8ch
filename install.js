#!/usr/bin/env node
/**
 * disp8ch bootstrap — single command to install everything.
 *
 * Usage: node install.js [--no-start] [--cli-setup] [--web-first] [--with-computer-use]
 *
 * This script:
 * 1. Checks Node.js version (22+ required)
 * 2. Enables corepack (ships with Node.js, manages pnpm)
 * 3. Runs pnpm install
 * 4. Runs web-first bootstrap by default (or pnpm run setup with --cli-setup)
 * 5. Starts dev server + opens browser (unless --no-start)
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const process = require("process");

const MIN_NODE = 22;
const DEFAULT_PORT = 3100;

function isWSL() {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
    return true;
  } catch {
    return false;
  }
}

function runQuiet(cmd) {
  try {
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function resolvePnpmCommand() {
  if (runQuiet("pnpm --version")) return "pnpm";
  if (runQuiet("corepack pnpm --version")) return "corepack pnpm";
  return "npx -y pnpm@10.30.2";
}

function resolveDpcCommand(pnpmCommand) {
  if (runQuiet("dpc --help")) return "dpc";
  if (runQuiet(`${pnpmCommand} dpc --help`)) return `${pnpmCommand} dpc`;
  if (runQuiet(`${pnpmCommand} exec -- dpc --help`)) return `${pnpmCommand} exec -- dpc`;
  return "node ./scripts/cli-bin.js";
}

function resolveCuaDriverCommand() {
  const explicit = String(process.env.DISP8CH_CUA_DRIVER_CMD || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.platform === "win32") {
    const defaultPath = path.join(process.env.LOCALAPPDATA || "", "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
    if (defaultPath && fs.existsSync(defaultPath)) return defaultPath;
    try {
      const found = execSync("where cua-driver", { stdio: "pipe", encoding: "utf8" })
        .split(/\r?\n/)
        .find((line) => line.trim());
      return found ? found.trim() : "";
    } catch {
      return "";
    }
  }
  try {
    const found = execSync("command -v cua-driver", { stdio: "pipe", encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  for (const candidate of [path.join(process.env.HOME || "", ".local", "bin", "cua-driver"), path.join(process.env.HOME || "", ".cua", "bin", "cua-driver")]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function upsertEnvValues(values) {
  const envPath = path.join(process.cwd(), ".env.local");
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const lineMap = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Z0-9_]+)=/);
    if (match) lineMap.set(match[1], i);
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const index = lineMap.get(key);
    if (index === undefined) {
      lines.push(line);
    } else {
      lines[index] = line;
    }
  }
  fs.writeFileSync(envPath, `${lines.join("\n").trim()}\n`, "utf8");
}

function installCuaDriver() {
  console.log("  Installing optional Cua Driver for Computer Use...");
  const psUrl = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1";
  const shUrl = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh";
  const ok =
    process.platform === "win32"
      ? run(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm ${psUrl} | iex"`)
      : run(`/bin/bash -c "$(curl -fsSL ${shUrl})"`);
  if (!ok) {
    console.warn("  Warning: Cua Driver install failed. disp8ch install will continue; Settings > Computer Use will show the remaining setup.");
  }
  return ok;
}

function configureComputerUseEnv(enable) {
  const values = { DISP8CH_CUA_TELEMETRY: "0" };
  if (enable) {
    values.DISP8CH_ENABLE_COMPUTER_USE = "1";
    process.env.DISP8CH_ENABLE_COMPUTER_USE = "1";
  }
  const driver = resolveCuaDriverCommand();
  if (driver) {
    values.DISP8CH_CUA_DRIVER_CMD = driver;
    process.env.DISP8CH_CUA_DRIVER_CMD = driver;
    console.log(`  Cua Driver detected: ${driver}`);
  } else {
    console.warn("  Warning: Cua Driver was not found on PATH. Computer Use will remain not-ready until the driver is installed.");
  }
  upsertEnvValues(values);
}

function printWindowsRetryHint() {
  if (process.platform !== "win32") return;
  console.error("  Windows tip: Use PowerShell, not Command Prompt, and retry:");
  console.error(`    cd "${process.cwd()}"`);
  console.error("    node install.js");
  console.error("");
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      const launchers = [
        ["cmd.exe", ["/c", "start", "", url]],
        ["powershell.exe", ["-NoProfile", "-Command", "Start-Process", url]],
        ["explorer.exe", [url]],
      ];
      for (const [command, args] of launchers) {
        try {
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
          });
          child.on("error", () => {});
          child.unref();
          return;
        } catch {}
      }
      return;
    }

    if (isWSL()) {
      const launchers = [
        ["powershell.exe", ["-NoProfile", "-Command", "Start-Process", url]],
        ["cmd.exe", ["/c", "start", "", url]],
      ];
      for (const [command, args] of launchers) {
        try {
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
          });
          child.on("error", () => {});
          child.unref();
          return;
        } catch {}
      }
      return;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      return;
    }

    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Browser open is best-effort; app still starts even if this fails.
  }
}

function startDevServer(url, pnpmCommand) {
  const devCommand = `${pnpmCommand} dev`;
  const launcher = process.platform === "win32" ? "powershell.exe" : "sh";
  const launcherArgs =
    process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", devCommand]
      : ["-lc", devCommand];

  const devProcess = spawn(launcher, launcherArgs, {
    env: process.env,
    stdio: "inherit",
  });

  const openTimer = setTimeout(() => {
    console.log(`\n  Opening ${url}\n`);
    openBrowser(url);
  }, 4500);

  devProcess.on("error", (error) => {
    clearTimeout(openTimer);
    console.error(`\n  Failed to start dev server (${String(error)}).`);
    console.error(`  Run manually: ${pnpmCommand} dev\n`);
    printWindowsRetryHint();
    process.exit(1);
  });

  devProcess.on("exit", (code, signal) => {
    clearTimeout(openTimer);
    if (signal) process.exit(0);
    process.exit(code || 0);
  });

  process.on("SIGINT", () => devProcess.kill("SIGINT"));
  process.on("SIGTERM", () => devProcess.kill("SIGTERM"));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const skipStart = args.has("--no-start");
  const cliSetup = args.has("--cli-setup");
  const webFirst = args.has("--web-first") || !cliSetup;
  const withComputerUse = args.has("--with-computer-use") || truthy(process.env.DISP8CH_WITH_COMPUTER_USE);
  const installCua = args.has("--install-cua") || withComputerUse || truthy(process.env.DISP8CH_INSTALL_CUA);
  const enableComputerUse =
    args.has("--enable-computer-use") || withComputerUse || truthy(process.env.DISP8CH_ENABLE_COMPUTER_USE_ON_INSTALL);

  console.log("\n  disp8ch installer\n");

  // 1. Check Node.js
  const nodeVersion = parseInt(process.version.replace("v", "").split(".")[0], 10);
  if (nodeVersion < MIN_NODE) {
    console.error(`  Node.js v${MIN_NODE}+ required. You have ${process.version}.`);
    console.error("  Download from: https://nodejs.org\n");
    process.exit(1);
  }
  console.log(`  Node.js ${process.version} — OK`);
  if (process.platform === "win32") {
    console.log("  Windows detected. PowerShell is the supported shell for installation and startup.");
  }
  if (isWSL()) {
    console.log("  WSL detected. Web-first mode will try to open your Windows browser automatically.");
  }

  // 2. Enable corepack (gives us pnpm without manual install)
  console.log("  Enabling corepack...");
  if (!run("corepack enable")) {
    // Fallback: install pnpm via npm
    console.log("  Corepack not available, installing pnpm via npm...");
    if (!run("npm install -g pnpm")) {
      console.error("  Failed to install pnpm. Install manually: npm install -g pnpm\n");
      printWindowsRetryHint();
      process.exit(1);
    }
  }

  // 3. Resolve how we'll run pnpm commands (works across cmd/PowerShell/bash/zsh)
  const pnpmCommand = resolvePnpmCommand();
  const dpcCommand = resolveDpcCommand(pnpmCommand);
  console.log(`  Package runner — ${pnpmCommand}`);

  // 4. Install dependencies
  console.log("\n  Installing dependencies...\n");
  if (!run(`${pnpmCommand} install`)) {
    console.error("\n  pnpm install failed.\n");
    printWindowsRetryHint();
    process.exit(1);
  }

  // 5. Run setup flow
  if (webFirst) {
    console.log("\n  Bootstrapping web-first setup...\n");
    if (!run(`${dpcCommand} init --ensure-env`)) {
      console.error(`\n  Web-first bootstrap failed. You can retry with: ${dpcCommand} init --ensure-env\n`);
      printWindowsRetryHint();
      process.exit(1);
    }
  } else {
    console.log("\n  Running CLI setup wizard...\n");
    if (!run(`${pnpmCommand} run setup`)) {
      console.error(`\n  Setup wizard failed. You can retry with: ${pnpmCommand} run setup\n`);
      printWindowsRetryHint();
      process.exit(1);
    }
  }

  if (installCua) {
    installCuaDriver();
  }
  if (installCua || enableComputerUse) {
    configureComputerUseEnv(enableComputerUse);
  }

  if (skipStart) {
    console.log("\n  Setup complete.");
    console.log(`  Start disp8ch manually with: ${pnpmCommand} dev`);
    console.log(`  → http://localhost:${DEFAULT_PORT}${webFirst ? "/onboarding" : ""}\n`);
    return;
  }

  const appUrl = `http://localhost:${DEFAULT_PORT}${webFirst ? "/onboarding" : ""}`;
  console.log(`\n  Setup complete. Starting disp8ch (${webFirst ? "web-first mode" : "CLI-configured mode"})...\n`);
  startDevServer(appUrl, pnpmCommand);
}

main();
