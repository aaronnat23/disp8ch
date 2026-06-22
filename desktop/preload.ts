import { contextBridge, ipcRenderer } from "electron";

/** Typed desktop bridge exposed through the canonical disp8ch IPC channels. */
const bridge = {
  getHealth: () => ipcRenderer.invoke("disp8ch:get-health"),
  runDoctor: () => ipcRenderer.invoke("disp8ch:run-doctor"),
  checkUpdates: () => ipcRenderer.invoke("disp8ch:check-updates"),
  downloadUpdate: () => ipcRenderer.invoke("disp8ch:download-update"),
  restartRuntime: () => ipcRenderer.invoke("disp8ch:restart-runtime"),
  // Native-picker-owned import: no arbitrary source path is accepted from the renderer.
  importDatabase: () => ipcRenderer.invoke("disp8ch:import-database"),
  openDataDir: () => ipcRenderer.invoke("disp8ch:open-data-dir"),
  openLogsDir: () => ipcRenderer.invoke("disp8ch:open-logs-dir"),
  notify: (payload: { id: string; title: string; body?: string; href?: string; severity?: string }) =>
    ipcRenderer.invoke("disp8ch:notify", payload),
  setAttention: (payload: { count: number; critical?: number }) =>
    ipcRenderer.invoke("disp8ch:set-attention", payload),
  openSessionWindow: (payload: { sessionId: string; interactive?: boolean }) =>
    ipcRenderer.invoke("disp8ch:open-session-window", payload),
} as const;

export type Disp8chDesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld("disp8chDesktop", bridge);
