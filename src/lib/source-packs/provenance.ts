/**
 * Source-pack provenance + drift detection. A learned skill records the source
 * pack it came from; this module lets the app show exactly which files/documents
 * produced a skill and detect when those sources have since changed (drift).
 */
import { getDocumentById } from "@/lib/documents/store";
import { extractFile, sha256 } from "./extractors";
import { getSourcePack, listSourcePackItems } from "./store";
import type { SourcePackDriftItem, SourcePackDriftReport } from "./types";

/** Re-hash each item's current source and compare against the stored hash. */
export function checkSourcePackDrift(sourcePackId: string): SourcePackDriftReport {
  const items = listSourcePackItems(sourcePackId);
  const driftItems: SourcePackDriftItem[] = [];
  for (const item of items) {
    let currentSha: string | null = null;
    let state: SourcePackDriftItem["state"] = "unknown";

    if (item.sourceUri && item.sourceUri.startsWith("document:")) {
      const docId = item.sourceUri.slice("document:".length);
      const doc = getDocumentById(docId);
      if (!doc) {
        state = "missing";
      } else {
        currentSha = sha256(doc.extractedText || "");
        state = currentSha === item.sha256 ? "unchanged" : "changed";
      }
    } else if (item.sourceUri && !/^[a-z]+:\/\//i.test(item.sourceUri)) {
      // Treat as a filesystem path (Windows drive letters like C:\ are fine;
      // url:// schemes and document: refs are handled above / skipped).
      const extracted = extractFile(item.sourceUri);
      if (extracted.skippedReason === "unreadable") {
        state = "missing";
      } else {
        currentSha = sha256(extracted.text ?? `${item.displayName}:${extracted.skippedReason ?? "skipped"}`);
        state = currentSha === item.sha256 ? "unchanged" : "changed";
      }
    }

    driftItems.push({
      itemId: item.id,
      displayName: item.displayName,
      sourceUri: item.sourceUri,
      state,
      storedSha256: item.sha256,
      currentSha256: currentSha,
    });
  }

  return {
    sourcePackId,
    checkedAt: new Date().toISOString(),
    drifted: driftItems.some((i) => i.state === "changed" || i.state === "missing"),
    items: driftItems,
  };
}

/** Human-readable provenance summary for a skill's source pack. */
export function buildProvenanceSummary(sourcePackId: string): string {
  const pack = getSourcePack(sourcePackId);
  if (!pack) return "Source pack not found.";
  const items = listSourcePackItems(sourcePackId);
  const usable = items.filter((i) => !i.skippedReason);
  const lines = [
    `Source pack: ${pack.name} (${pack.id})`,
    `Origin: ${pack.originType}; ${usable.length} usable source(s), ${pack.chunkCount} chunk(s).`,
    ...usable.slice(0, 25).map((i) => `- ${i.displayName}${i.sourceUri ? ` [${i.sourceUri}]` : ""} (sha ${i.sha256.slice(0, 12)})`),
  ];
  return lines.join("\n");
}
