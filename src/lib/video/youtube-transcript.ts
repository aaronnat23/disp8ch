export type YouTubeTranscriptSegment = {
  startSeconds: number;
  durationSeconds?: number;
  text: string;
  language?: string;
  source: "manual_caption" | "auto_caption" | "unknown";
};

export type YouTubeTranscriptResult = {
  success: boolean;
  videoId: string;
  title?: string;
  language?: string;
  segments?: YouTubeTranscriptSegment[];
  transcriptText?: string;
  errorType?: "no_captions" | "private_video" | "network_error" | "blocked" | "unsupported_url";
  error?: string;
};

export function extractYouTubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/i);
  return match?.[1] ?? null;
}

export function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+/i.test(url);
}

export async function fetchYouTubeTranscript(url: string): Promise<YouTubeTranscriptResult> {
  const videoId = extractYouTubeId(url);

  if (!videoId) {
    return {
      success: false,
      videoId: url.slice(0, 20),
      errorType: "unsupported_url",
      error: "Could not extract a valid YouTube video ID from the URL.",
    };
  }

  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        videoId,
        errorType: response.status === 403 || response.status === 404 ? "private_video" : "network_error",
        error: `Failed to fetch YouTube page: HTTP ${response.status}`,
      };
    }

    const html = await response.text();

    if (/video\s+is\s+(?:private|unavailable|removed)/i.test(html)) {
      return {
        success: false,
        videoId,
        errorType: "private_video",
        error: "Video is private or unavailable.",
      };
    }

    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch?.[1]
      ?.replace(/ - YouTube$/, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .trim();

    const captionsMatch = html.match(/"captions":(\{.*?\}\s*\]\s*\}\s*\})/);
    if (!captionsMatch?.[1]) {
      return {
        success: false,
        videoId,
        title,
        errorType: "no_captions",
        error: "No captions track found for this video.",
      };
    }

    let captionsData: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          baseUrl: string;
          languageCode?: string;
          kind?: string;
          name?: { simpleText?: string };
          vssId?: string;
        }>;
      };
    };
    try {
      captionsData = JSON.parse(captionsMatch[1].replace(/\\"/g, '"'));
    } catch {
      return {
        success: false,
        videoId,
        title,
        errorType: "no_captions",
        error: "Failed to parse captions data from YouTube page.",
      };
    }

    const tracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      return {
        success: false,
        videoId,
        title,
        errorType: "no_captions",
        error: "No captions tracks available.",
      };
    }

    const enTrack = tracks.find((t) => t.languageCode === "en") || tracks[0];
    const isAuto = enTrack.vssId?.startsWith("a.") || enTrack.kind === "asr";

    const transcriptResponse = await fetch(enTrack.baseUrl);
    if (!transcriptResponse.ok) {
      return {
        success: false,
        videoId,
        title,
        errorType: "network_error",
        error: `Failed to fetch transcript: HTTP ${transcriptResponse.status}`,
      };
    }

    const transcriptXml = await transcriptResponse.text();
    const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)">([^<]*)<\/text>/g;
    const segments: YouTubeTranscriptSegment[] = [];
    const transcriptLines: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = textRegex.exec(transcriptXml)) !== null) {
      const startSeconds = parseFloat(match[1]);
      const durationSeconds = parseFloat(match[2]);
      const text = match[3]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text) {
        segments.push({
          startSeconds,
          durationSeconds,
          text,
          language: enTrack.languageCode,
          source: isAuto ? "auto_caption" : "manual_caption",
        });
        transcriptLines.push(text);
      }
    }

    if (segments.length === 0) {
      return {
        success: false,
        videoId,
        title,
        errorType: "no_captions",
        error: "Transcript XML was empty or contained no text segments.",
      };
    }

    return {
      success: true,
      videoId,
      title,
      language: enTrack.languageCode,
      segments,
      transcriptText: transcriptLines.join(" "),
    };
  } catch (err) {
    return {
      success: false,
      videoId,
      errorType: "network_error",
      error: `YouTube transcript fetch error: ${String(err)}`,
    };
  }
}

export function formatTranscriptForPrompt(result: YouTubeTranscriptResult): string {
  if (!result.success || !result.segments) return "";

  const lines: string[] = [
    `YouTube transcript for ${result.videoId}${result.title ? ` ("${result.title}")` : ""}`,
    `Language: ${result.language ?? "unknown"}. Source: ${result.segments[0]?.source ?? "unknown"}.`,
    "",
  ];

  let currentMinute = -1;
  for (const segment of result.segments) {
    const minute = Math.floor(segment.startSeconds / 60);
    if (minute !== currentMinute) {
      currentMinute = minute;
      lines.push(`\n[${String(minute).padStart(2, "0")}:${String(Math.floor(segment.startSeconds % 60)).padStart(2, "0")}] ${segment.text}`);
    } else {
      lines[lines.length - 1] += ` ${segment.text}`;
    }
  }

  return lines.join(" ");
}
