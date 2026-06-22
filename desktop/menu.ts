import { Menu, app, dialog, shell } from "electron";
import { detectRepoDatabaseCandidate, importDatabaseFromFile } from "./data-import";
import {
  getRuntimeHandle,
  getDesktopDoctorReport,
  resolveDesktopAppRoot,
  restartDesktopRuntime,
  startDesktopRuntime,
  stopDesktopRuntime,
} from "./runtime";
import { checkDesktopUpdates, downloadDesktopUpdate } from "./update";

async function showUpdateStatus(): Promise<void> {
  const status = await checkDesktopUpdates({ currentVersion: app.getVersion() });
  const detail = [
    status.message,
    status.latestVersion ? `Latest: ${status.latestVersion}` : null,
    status.artifact?.url ? `Artifact: ${status.artifact.url}` : null,
    status.manifestUrl ? `Feed: ${status.manifestUrl}` : null,
  ].filter(Boolean).join("\n");
  const buttons = status.downloadAllowed ? ["Download Verified Installer", "OK"] : ["OK"];
  const response = await dialog.showMessageBox({
    type: status.status === "error" ? "error" : status.status === "available" ? "info" : "none",
    title: "disp8ch Updates",
    message: status.status === "available" ? "Update available" : "Update status",
    detail,
    buttons,
    defaultId: buttons.length === 1 ? 0 : 1,
    cancelId: buttons.length === 1 ? 0 : 1,
  });
  if (status.downloadAllowed && response.response === 0) {
    const result = await downloadDesktopUpdate({ currentVersion: app.getVersion() });
    await dialog.showMessageBox({
      type: "info",
      title: "disp8ch Updates",
      message: "Installer downloaded and verified",
      detail: `${result.message}\n\nPath: ${result.filePath}\nSHA-256: ${result.sha256}`,
    });
    shell.showItemInFolder(result.filePath);
  }
}

export async function importExistingDatabase(
  onOpen: () => void,
): Promise<{ ok: boolean; canceled?: boolean; message: string }> {
  const handle = getRuntimeHandle();
  if (!handle) {
    await dialog.showMessageBox({ type: "warning", message: "Runtime is not started yet." });
    return { ok: false, message: "Runtime is not started yet." };
  }

  const repoCandidate = detectRepoDatabaseCandidate(resolveDesktopAppRoot());
  const selected = await dialog.showOpenDialog({
    title: "Import existing disp8ch database",
    defaultPath: repoCandidate || undefined,
    properties: ["openFile"],
    filters: [
      { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (selected.canceled || !selected.filePaths[0]) {
    return { ok: false, canceled: true, message: "Import canceled." };
  }

  const confirm = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Import", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Import database",
    message: "Import this database into the desktop data folder?",
    detail: "disp8ch will stop the local runtime, back up the current desktop database if one exists, copy the selected file, and restart.",
  });
  if (confirm.response !== 0) {
    return { ok: false, canceled: true, message: "Import canceled." };
  }

  await stopDesktopRuntime();
  try {
    const result = importDatabaseFromFile(selected.filePaths[0], handle.dataDir);
    await startDesktopRuntime();
    onOpen();
    await dialog.showMessageBox({
      type: "info",
      title: "Database imported",
      message: "Database import complete",
      detail: result.message,
    });
    return { ok: true, message: result.message };
  } catch (error) {
    await startDesktopRuntime().catch(() => {});
    throw error;
  }
}

export function installAppMenu(onOpen: () => void): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "disp8ch",
      submenu: [
        { label: "Open disp8ch", click: onOpen },
        {
          label: "Restart Runtime",
          click: async () => {
            await restartDesktopRuntime();
            onOpen();
          },
        },
        {
          label: "Run Doctor",
          click: async () => {
            const report = await getDesktopDoctorReport();
            const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`;
            await shell.openExternal(dataUrl);
          },
        },
        {
          label: "Check For Updates",
          click: () => {
            showUpdateStatus().catch((error) => dialog.showErrorBox("Update check failed", String(error)));
          },
        },
        {
          label: "Import Existing Database...",
          click: () => {
            importExistingDatabase(onOpen).catch((error) => dialog.showErrorBox("Database import failed", String(error)));
          },
        },
        {
          label: "Open Data Folder",
          click: async () => {
            const handle = getRuntimeHandle();
            if (handle) await shell.openPath(handle.dataDir);
          },
        },
        {
          label: "Open Logs Folder",
          click: async () => {
            const handle = getRuntimeHandle();
            if (handle) await shell.openPath(handle.logsDir);
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
