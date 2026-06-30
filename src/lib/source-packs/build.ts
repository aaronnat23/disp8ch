/**
 * Source-pack builders. These turn concrete origins (folders, documents,
 * notebooks, notes, conversations) into a hashed, chunked, bounded source pack.
 * The folder builder uses the ignore-aware bounded walker so "learn this
 * folder" can never scan a whole drive.
 */
import path from "node:path";
import { getDocumentById } from "@/lib/documents/store";
import { extractFile, sha256, walkFolder } from "./extractors";
import { addSourcePackItem, createSourcePack, getSourcePack, setSourcePackStatus } from "./store";
import type { SourcePack, SourcePackCreatedBySurface } from "./types";

export type BuildResult = {
  pack: SourcePack;
  added: number;
  skipped: number;
};

/** Build a pack from a bounded folder walk. */
export function buildSourcePackFromFolder(input: {
  name: string;
  description?: string | null;
  folderPath: string;
  createdBySurface?: SourcePackCreatedBySurface;
}): BuildResult {
  const folderPath = path.resolve(input.folderPath);
  const pack = createSourcePack({
    name: input.name,
    description: input.description ?? `Folder: ${folderPath}`,
    originType: "folder",
    originRefs: [folderPath],
    createdBySurface: input.createdBySurface ?? "documents",
  });

  const files = walkFolder(folderPath);
  let added = 0;
  let skipped = 0;
  for (const file of files) {
    const extracted = extractFile(file.absPath);
    addSourcePackItem({
      sourcePackId: pack.id,
      kind: "file",
      displayName: file.relPath || path.basename(file.absPath),
      sourceUri: file.absPath,
      mimeType: extracted.mimeType,
      text: extracted.text,
      sizeBytes: extracted.sizeBytes,
      skippedReason: extracted.skippedReason,
      metadata: { relPath: file.relPath },
    });
    if (extracted.skippedReason) skipped++;
    else added++;
  }

  return { pack: setSourcePackStatus(pack.id, "indexed"), added, skipped };
}

/** Build a pack from existing Documents (data sources / notebook sources). */
export function buildSourcePackFromDocuments(input: {
  name: string;
  description?: string | null;
  documentIds: string[];
  originType?: "document" | "notebook" | "mixed";
  createdBySurface?: SourcePackCreatedBySurface;
}): BuildResult {
  const pack = createSourcePack({
    name: input.name,
    description: input.description ?? null,
    originType: input.originType ?? "document",
    originRefs: input.documentIds,
    createdBySurface: input.createdBySurface ?? "documents",
  });

  let added = 0;
  let skipped = 0;
  for (const docId of input.documentIds) {
    const doc = getDocumentById(docId);
    if (!doc) {
      addSourcePackItem({
        sourcePackId: pack.id,
        kind: "document",
        displayName: docId,
        sourceUri: `document:${docId}`,
        text: null,
        skippedReason: "document not found",
      });
      skipped++;
      continue;
    }
    const text = doc.extractedText || "";
    addSourcePackItem({
      sourcePackId: pack.id,
      kind: "document",
      displayName: doc.name,
      sourceUri: `document:${doc.id}`,
      mimeType: "text/plain",
      text: text || null,
      skippedReason: text ? null : "empty document",
      metadata: { sourceType: doc.sourceType, sourceUrl: doc.sourceUrl ?? null },
    });
    if (text) added++;
    else skipped++;
  }

  return { pack: setSourcePackStatus(pack.id, "indexed"), added, skipped };
}

/** Append a freeform note or conversation excerpt to an existing pack. */
export function appendNoteToSourcePack(input: {
  sourcePackId: string;
  displayName: string;
  text: string;
  kind?: "note" | "conversation";
  sourceUri?: string | null;
}): SourcePack {
  const pack = getSourcePack(input.sourcePackId);
  if (!pack) throw new Error(`Source pack not found: ${input.sourcePackId}`);
  addSourcePackItem({
    sourcePackId: input.sourcePackId,
    kind: input.kind ?? "note",
    displayName: input.displayName,
    sourceUri: input.sourceUri ?? null,
    mimeType: "text/plain",
    text: input.text,
  });
  return getSourcePack(input.sourcePackId)!;
}

/** Stable content hash for the whole pack (used to detect later changes). */
export function sourcePackContentHash(sourcePackId: string): string {
  const { listSourcePackItems } = require("./store") as typeof import("./store");
  const items = listSourcePackItems(sourcePackId);
  return sha256(items.map((i) => `${i.displayName}:${i.sha256}`).join("\n"));
}
