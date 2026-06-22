import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.cwd();

function packagedExecutable(): string {
  if (process.platform === "win32") return path.join(root, "dist", "desktop", "win-unpacked", "disp8ch AI.exe");
  if (process.platform === "darwin") return path.join(root, "dist", "desktop", "mac", "disp8ch AI.app", "Contents", "MacOS", "disp8ch AI");
  return path.join(root, "dist", "desktop", "linux-unpacked", "disp8ch");
}

function waitForHealth(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, { timeout: 2500 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            resolve(body);
            return;
          }
          retry(`HTTP ${res.statusCode || "unknown"}`);
        });
      });
      req.on("timeout", () => {
        req.destroy();
        retry("timeout");
      });
      req.on("error", (error) => retry(error.message));
    };
    const retry = (last: string) => {
      if (Date.now() >= deadline) {
        reject(new Error(`Packaged app health did not become ready: ${last}`));
        return;
      }
      setTimeout(poll, 1500);
    };
    poll();
  });
}

async function stop(child: ChildProcess | null) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill();
  }
  if (process.platform === "win32") {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("taskkill.exe", ["/IM", "disp8ch AI.exe", "/F", "/T"], { stdio: "ignore" });
    } catch {
      // The process may already be gone.
    }
  }
}

async function main() {
  const exe = packagedExecutable();
  assert(fs.existsSync(exe), `Packaged executable missing at ${exe}. Run electron-builder --dir first.`);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  try {
    const body = await waitForHealth("http://127.0.0.1:3100/api/health", 120000);
    const parsed = JSON.parse(body) as {
      ok?: boolean;
      installChannel?: string;
      database?: string;
      dataDir?: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.installChannel, "desktop");
    assert.equal(parsed.database, "ok");
    assert(parsed.dataDir && !parsed.dataDir.includes(`${path.sep}disp8ch${path.sep}data`), "desktop health must use app-data database, not repo data/");
    console.log("desktop-packaged-health-smoke: ok");
  } finally {
    await stop(child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
