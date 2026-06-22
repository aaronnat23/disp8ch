import { listBackups } from "@/lib/backup/manager";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const backupRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return "Backup guidance:\n- Before destructive or high-risk changes, create and verify a backup snapshot.";
  },
  handleCommand(message) {
    if (!/^show\s+backup\s+extension\s+status$/i.test(message.trim())) return null;
    const backups = listBackups();
    const latest = backups[0] ?? null;
    return `Backup Manager\nSnapshots: ${backups.length}\nLatest: ${latest?.id ?? "none"}`;
  },
  getStatus() {
    const backups = listBackups();
    return {
      backupCount: backups.length,
      latestBackupId: backups[0]?.id ?? null,
    };
  },
};

export default backupRuntime;
