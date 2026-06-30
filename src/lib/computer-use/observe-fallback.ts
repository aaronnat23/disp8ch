import { spawnSync } from "node:child_process";

export type ActiveWindowSummary = {
  app: string | null;
  title: string | null;
};

function clean(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

export function observationLooksEmpty(text: string | null | undefined): boolean {
  const normalized = clean(text);
  if (!normalized) return true;
  return /^(?:\(?no text observed\)?|no visible text|empty observation)$/i.test(normalized);
}

export function mergeObservationWithActiveWindow(
  text: string | null | undefined,
  fallback: ActiveWindowSummary | null,
): string | null {
  const current = clean(text);
  if (!observationLooksEmpty(current)) return current;

  const app = clean(fallback?.app);
  const title = clean(fallback?.title);
  if (!app && !title) return current;

  const label = [app, title].filter(Boolean).join(" - ");
  return `Active desktop window: ${label}. Cua did not return visible OCR text for this observe call.`;
}

export function appendActiveWindowSummary(
  text: string | null | undefined,
  fallback: ActiveWindowSummary | null,
): string | null {
  const merged = mergeObservationWithActiveWindow(text, fallback);
  const app = clean(fallback?.app);
  const title = clean(fallback?.title);
  if (!merged || observationLooksEmpty(text) || (!app && !title)) return merged;

  const label = [app, title].filter(Boolean).join(" - ");
  if (merged.includes(label)) return merged;
  return `Foreground window: ${label}\n${merged}`;
}

function run(command: string, args: string[], timeout = 3000): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return clean(result.stdout);
  } catch {
    return null;
  }
}

function readWindowsActiveWindow(): ActiveWindowSummary | null {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Disp8chWindowProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$handle = [Disp8chWindowProbe]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 1024
[void][Disp8chWindowProbe]::GetWindowText($handle, $builder, $builder.Capacity)
[Console]::Out.Write($builder.ToString())
`;
  const title = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  return title ? { app: null, title } : null;
}

function readMacActiveWindow(): ActiveWindowSummary | null {
  const app = run("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
  const title = run("osascript", [
    "-e",
    'tell application "System Events" to tell first application process whose frontmost is true to get name of front window',
  ]);
  return app || title ? { app, title } : null;
}

function readLinuxActiveWindow(): ActiveWindowSummary | null {
  const title = run("xdotool", ["getactivewindow", "getwindowname"]);
  return title ? { app: null, title } : null;
}

export function readActiveWindowSummary(): ActiveWindowSummary | null {
  if (/^(1|true|yes|on)$/i.test(String(process.env.DISP8CH_DISABLE_COMPUTER_OBSERVE_FALLBACK || "").trim())) {
    return null;
  }
  if (process.platform === "win32") return readWindowsActiveWindow();
  if (process.platform === "darwin") return readMacActiveWindow();
  if (process.platform === "linux") return readLinuxActiveWindow();
  return null;
}
