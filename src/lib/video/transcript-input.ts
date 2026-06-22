export type ProvidedTranscript = {
  source: "user_provided";
  text: string;
  timestampsAvailable: boolean;
  format: "srt" | "vtt" | "plain" | "unknown";
  segments: Array<{ start?: number; duration?: number; text: string }>;
};

export function detectProvidedTranscript(message: string): ProvidedTranscript | null {
  const codeBlock = message.match(/```(?:srt|vtt|text|plain)?\s*\n([\s\S]*?)\n```/);
  if (codeBlock?.[1]) {
    const text = codeBlock[1].trim();
    const segments = parseTranscriptSegments(text);
    return {
      source: "user_provided",
      text,
      timestampsAvailable: segments.some((s) => s.start !== undefined),
      format: detectFormat(text),
      segments,
    };
  }

  const inlineTranscript = /(?:transcript|captions?|subtitles?)\s*(?::|is|are)?\s*\n([\s\S]{200,})/i.exec(message);
  if (inlineTranscript?.[1]) {
    const text = inlineTranscript[1].trim();
    const segments = parseTranscriptSegments(text);
    return {
      source: "user_provided",
      text,
      timestampsAvailable: segments.some((s) => s.start !== undefined),
      format: detectFormat(text),
      segments,
    };
  }

  const pastedTimestamped = /(?:here(?:'s| is) the transcript|I(?:'ll| will) paste the transcript)\s*\n([\s\S]{200,})/i.exec(message);
  if (pastedTimestamped?.[1]) {
    const text = pastedTimestamped[1].trim();
    const segments = parseTranscriptSegments(text);
    return {
      source: "user_provided",
      text,
      timestampsAvailable: segments.some((s) => s.start !== undefined),
      format: detectFormat(text),
      segments,
    };
  }

  return null;
}

export function parseTimestampedTranscript(text: string): Array<{ start?: number; duration?: number; text: string }> {
  return parseTranscriptSegments(text);
}

export function formatUnavailableTranscriptAnswer(videoId: string, attempts: Array<{ strategy: string; ok: boolean; durationMs: number }>): string {
  const attemptSummary = attempts
    .map((a) => `${a.strategy}: ${a.ok ? "ok" : "failed"} (${a.durationMs}ms)`)
    .join(", ");

  return [
    `Transcript unavailable for video \`${videoId}\`.`,
    "",
    "Attempted strategies:",
    attempts.map((a) => `- ${a.strategy}: ${a.ok ? "succeeded" : "failed"} in ${a.durationMs}ms`).join("\n"),
    "",
    "No transcript content was extracted. I will not summarize from title, metadata, or watch-page content.",
    "",
    "To get a summary, you can:",
    "1. Provide the transcript text directly (paste it into the chat)",
    "2. Upload a subtitle file (`.srt` or `.vtt`)",
    "3. Install `yt-dlp` and configure a transcript adapter if your environment supports it",
    "4. Manually copy captions from YouTube and paste them here",
    "",
    `Attempt summary: ${attemptSummary}.`,
  ].join("\n");
}

function detectFormat(text: string): "srt" | "vtt" | "plain" | "unknown" {
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) return "srt";
  if (/WEBVTT/i.test(text.slice(0, 50))) return "vtt";
  if (/\d+:\d{2}(?::\d{2})?\s/i.test(text)) return "plain";
  return "unknown";
}

function parseTranscriptSegments(text: string): Array<{ start?: number; duration?: number; text: string }> {
  const segments: Array<{ start?: number; duration?: number; text: string }> = [];

  // SRT format: 00:00:01,000 --> 00:00:04,000
  const srtRegex = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\d+\n|\n\n\d+\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = srtRegex.exec(text)) !== null) {
    const startH = parseInt(match[1]), startM = parseInt(match[2]), startS = parseInt(match[3]), startMs = parseInt(match[4]);
    const endH = parseInt(match[5]), endM = parseInt(match[6]), endS = parseInt(match[7]), endMs = parseInt(match[8]);
    const start = startH * 3600 + startM * 60 + startS + startMs / 1000;
    const end = endH * 3600 + endM * 60 + endS + endMs / 1000;
    segments.push({ start, duration: end - start, text: match[9].replace(/\n/g, " ").trim() });
  }
  if (segments.length > 0) return segments;

  // VTT format: HH:MM:SS.mmm --> HH:MM:SS.mmm
  const vttRegex = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*\n([\s\S]*?)(?=\n\d+\n|\n\n|$)/g;
  while ((match = vttRegex.exec(text)) !== null) {
    const startH = parseInt(match[1]), startM = parseInt(match[2]), startS = parseInt(match[3]), startMs = parseInt(match[4]);
    const endH = parseInt(match[5]), endM = parseInt(match[6]), endS = parseInt(match[7]), endMs = parseInt(match[8]);
    segments.push({
      start: startH * 3600 + startM * 60 + startS + startMs / 1000,
      duration: (endH * 3600 + endM * 60 + endS + endMs / 1000) - (startH * 3600 + startM * 60 + startS + startMs / 1000),
      text: match[9].replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim(),
    });
  }
  if (segments.length > 0) return segments;

  // Plain timestamp format: [00:01] text or 0:01 text
  const plainRegex = /(?:^|\n)\s*(?:\[(\d+):(\d{2})(?::(\d{2}))?\]|(\d+):(\d{2})(?::(\d{2}))?)\s+(.+?)(?=\n\s*(?:\[?\d+:\d{2})|$)/gm;
  while ((match = plainRegex.exec(text)) !== null) {
    let startSecs = 0;
    if (match[1] !== undefined) {
      startSecs = parseInt(match[1]) * 60 + parseInt(match[2]) + (match[3] ? parseInt(match[3]) : 0);
    } else if (match[4] !== undefined) {
      startSecs = parseInt(match[4]) * 60 + parseInt(match[5]) + (match[6] ? parseInt(match[6]) : 0);
    }
    segments.push({ start: startSecs, text: match[7].trim() });
  }

  return segments;
}
