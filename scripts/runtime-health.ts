import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type RuntimeHealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  summary: string;
  repair?: string | null;
};

export type RuntimeHealthReport = {
  ok: boolean;
  url?: string;
  checks: RuntimeHealthCheck[];
};

function parseArgs(argv: string[]) {
  const filtered = argv.filter((arg) => arg !== "--");
  const args = new Set(argv);
  const urlIndex = filtered.indexOf("--url");
  return {
    json: args.has("--json"),
    url: urlIndex >= 0 ? filtered[urlIndex + 1] : process.env.DISP8CH_HEALTH_URL || "http://127.0.0.1:3100/api/health",
    localOnly: args.has("--local-only"),
  };
}

export async function fetchHealth(url: string, timeoutMs = 5000): Promise<RuntimeHealthCheck> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          resolve({
            name: "http-health",
            status: "fail",
            summary: `HTTP ${response.statusCode || "unknown"} from ${url}`,
            repair: "Start disp8ch AI or check the selected port.",
          });
          return;
        }
        try {
          const parsed = JSON.parse(body) as { ok?: boolean; database?: string; onboardingDone?: boolean };
          resolve({
            name: "http-health",
            status: parsed.ok === false ? "warn" : "ok",
            summary: `reachable; database=${parsed.database || "unknown"}; onboardingDone=${String(parsed.onboardingDone ?? "unknown")}`,
            repair: parsed.ok === false ? "Open /api/health details or run dpc doctor." : null,
          });
        } catch {
          resolve({
            name: "http-health",
            status: "fail",
            summary: "Health endpoint returned non-JSON response",
            repair: "Check that the requested URL points to disp8ch AI.",
          });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({
        name: "http-health",
        status: "fail",
        summary: `Timed out after ${timeoutMs}ms: ${url}`,
        repair: "Start disp8ch AI or choose a free port.",
      });
    });
    request.on("error", (error) => {
      resolve({
        name: "http-health",
        status: "fail",
        summary: String(error.message || error),
        repair: "Start disp8ch AI or check firewall/port settings.",
      });
    });
  });
}

export function runDoctorJson(): RuntimeHealthCheck[] {
  try {
    const cliPath = path.resolve(process.cwd(), "scripts", "cli.ts");
    const raw = execFileSync(process.execPath, ["--import", "tsx", cliPath, "doctor", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      env: process.env,
    });
    const parsed = JSON.parse(raw) as { checks?: RuntimeHealthCheck[] };
    return (parsed.checks || []).map((check) => ({
      name: `doctor:${check.name}`,
      status: check.status,
      summary: check.summary,
      repair: check.repair ?? null,
    }));
  } catch (error) {
    return [{
      name: "doctor",
      status: "fail",
      summary: String(error),
      repair: "Run `dpc doctor` manually for details.",
    }];
  }
}

export async function runRuntimeHealth(options: { url?: string; includeHttp?: boolean } = {}): Promise<RuntimeHealthReport> {
  const checks = runDoctorJson();
  if (options.includeHttp !== false) {
    checks.push(await fetchHealth(options.url || "http://127.0.0.1:3100/api/health"));
  }
  return {
    ok: checks.every((check) => check.status !== "fail"),
    url: options.url,
    checks,
  };
}

function printReport(report: RuntimeHealthReport) {
  for (const check of report.checks) {
    const label = check.status === "ok" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${label}] ${check.name}: ${check.summary}`);
  }
  console.log(`Overall: ${report.ok ? "HEALTHY" : "UNHEALTHY"}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runRuntimeHealth({ url: args.url, includeHttp: !args.localOnly });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.parse(process.argv[1]).name === "runtime-health") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
