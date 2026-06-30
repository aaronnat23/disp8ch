/**
 * Source-pack domain model. A source pack is a bounded, hashed manifest of
 * extracted text from documents, notebooks, folders, uploads, URLs, or a
 * WebChat conversation. It is the deterministic intake layer that the
 * source-to-skill compiler reads from — the model never browses arbitrary files
 * directly; it only sees a built, audited pack.
 */

export type SourcePackOriginType =
  | "document"
  | "notebook"
  | "folder"
  | "upload"
  | "url"
  | "webchat"
  | "mixed";

export type SourcePackStatus = "draft" | "indexed" | "compiled" | "archived";

export type SourcePackCreatedBySurface = "documents" | "webchat" | "skills" | "design";

export type SourcePackItemKind = "file" | "document" | "chunk" | "url" | "note" | "conversation";

export type SourcePack = {
  id: string;
  name: string;
  description: string | null;
  originType: SourcePackOriginType;
  originRefs: string[];
  status: SourcePackStatus;
  createdBySurface: SourcePackCreatedBySurface;
  itemCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SourcePackItem = {
  id: string;
  sourcePackId: string;
  kind: SourcePackItemKind;
  displayName: string;
  sourceUri: string | null;
  mimeType: string | null;
  sha256: string;
  sizeBytes: number;
  textExcerpt: string | null;
  /** Set when an item was deliberately skipped (binary, oversized, ignored). */
  skippedReason: string | null;
  metadata: Record<string, unknown>;
};

export type SourcePackChunk = {
  id: string;
  sourcePackId: string;
  itemId: string;
  chunkIndex: number;
  content: string;
  tokenEstimate: number;
  sha256: string;
};

/** A drift report compares stored item hashes against current source hashes. */
export type SourcePackDriftItem = {
  itemId: string;
  displayName: string;
  sourceUri: string | null;
  state: "unchanged" | "changed" | "missing" | "unknown";
  storedSha256: string;
  currentSha256: string | null;
};

export type SourcePackDriftReport = {
  sourcePackId: string;
  checkedAt: string;
  drifted: boolean;
  items: SourcePackDriftItem[];
};
