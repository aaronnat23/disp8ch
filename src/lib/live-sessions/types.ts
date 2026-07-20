export type LiveSessionStatus =
  | "recording"
  | "paused"
  | "processing"
  | "complete"
  | "error";

export type LiveSession = {
  id: string;
  title: string;
  status: LiveSessionStatus;
  source: "microphone" | "fixture" | "text";
  language: string | null;
  sttProvider: string | null;
  consentConfirmedAt: string;
  startedAt: string;
  endedAt: string | null;
  notebookId: string | null;
  workTrailId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type LiveSessionSegment = {
  id: string;
  sessionId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  text: string;
  confidence: number | null;
  providerSegmentId: string | null;
  audioSha256: string;
  status: "processing" | "complete" | "failed";
  timestampPrecision: "provider" | "chunk" | "fixture";
  createdAt: string;
  updatedAt: string;
};

export type LiveSessionDetail = LiveSession & { segments: LiveSessionSegment[] };

export type TranscriptAnalysis = {
  summary: string;
  decisions: string[];
  actionItems: Array<{ action: string; owner: string | null; deadline: string | null; citations: string[] }>;
  risks: string[];
  openQuestions: string[];
  answer?: string;
};
