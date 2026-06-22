import path from "node:path";
import fs from "node:fs";
import { Tray, Menu, nativeImage, BrowserWindow, clipboard, app } from "electron";
import { getRuntimeHandle } from "./runtime";

let tray: Tray | null = null;

export function resolveTrayIconPath(): string {
  const candidates = [
    path.join(__dirname, "assets", "tray-icon.png"),
    path.join(app.getAppPath(), ".desktop", "assets", "tray-icon.png"),
    path.resolve(process.cwd(), "desktop", "assets", "tray-icon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function loadTrayImage(): Electron.NativeImage {
  const iconPath = resolveTrayIconPath();
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

export function installTray(window: BrowserWindow): void {
  if (process.platform === "darwin" || tray) return;
  tray = new Tray(loadTrayImage());
  tray.setToolTip("disp8ch");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open disp8ch",
      click: () => {
        window.show();
        window.focus();
      },
    },
    {
      label: "Copy Local URL",
      click: () => {
        const handle = getRuntimeHandle();
        if (handle) clipboard.writeText(handle.url);
      },
    },
    { type: "separator" },
    { role: "quit" },
  ]));
  tray.on("click", () => {
    window.show();
    window.focus();
  });
}

/** Update the tray tooltip to reflect current operational status. */
export function setTrayStatus(text: string): void {
  if (tray) tray.setToolTip(text ? `disp8ch — ${text}` : "disp8ch");
}
