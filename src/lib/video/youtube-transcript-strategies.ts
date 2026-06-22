import fs from "node:fs";
import path from "node:path";

export type TranscriptStrategy = "cache" | "watch_page" | "player_response" | "timedtext" | "yt_dlp";

export interface StrategyAttempt {
  strategy: TranscriptStrategy;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}

export interface TranscriptSegment {
  start: number;
  duration?: number;
  text: string;
}

export interface TranscriptSuccess {
  ok: true;
  videoId: string;
  title?: string;
  language?: string;
  isGenerated?: boolean;
  source: TranscriptStrategy;
  segments: TranscriptSegment[];
  fullText: string;
  timestampedText: string;
  attempts: StrategyAttempt[];
}

export interface TranscriptFailure {
  ok: false;
  videoId?: string;
  errorCode:
    | "invalid_url"
    | "no_caption_tracks"
    | "captions_disabled"
    | "language_unavailable"
    | "network_error"
    | "blocked"
    | "timeout"
    | "parse_error";
  attempts: StrategyAttempt[];
}

export type TranscriptResult = TranscriptSuccess | TranscriptFailure;
type StrategyErrors = Partial<Record<TranscriptStrategy, TranscriptFailure["errorCode"]>>;

function cacheDir(): string {
  const dir = path.resolve(process.cwd(), "data", "transcripts", "youtube");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(videoId: string): string {
  return path.join(cacheDir(), `${videoId}.json`);
}

async function tryCache(videoId: string): Promise<TranscriptSuccess | null> {
  const p = cachePath(videoId);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    const entry = JSON.parse(raw);
    if (entry.ok && entry.videoId === videoId && entry.segments?.length > 0) {
      return { ...entry, source: "cache" as const, attempts: [{ strategy: "cache", ok: true, durationMs: 0 }] };
    }
  } catch { /* ignore */ }
  return null;
}

function saveCache(result: TranscriptSuccess): void {
  try {
    fs.writeFileSync(cachePath(result.videoId), JSON.stringify(result, null, 2));
  } catch { /* ignore */ }
}

function classifyFetchError(err: unknown): TranscriptFailure["errorCode"] {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name?: unknown }).name) : "";
  const message = String(err);
  if (name === "TimeoutError" || message.toLowerCase().includes("timeout")) return "timeout";
  return "network_error";
}

function classifyHttpStatus(status: number): TranscriptFailure["errorCode"] {
  if (status === 403 || status === 429) return "blocked";
  if (status === 404) return "network_error";
  return "network_error";
}

async function tryWatchPage(videoId: string, errors: StrategyErrors): Promise<TranscriptSuccess | null> {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      errors.watch_page = classifyHttpStatus(response.status);
      return null;
    }
    const html = await response.text();

    if (/video\s+is\s+(?:private|unavailable|removed)/i.test(html)) {
      errors.watch_page = "blocked";
      return null;
    }

    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch?.[1]
      ?.replace(/ - YouTube$/, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .trim();

    const captionsMatch = html.match(/"captions":(\{.*?\}\s*\]\s*\}\s*\})/);
    if (!captionsMatch?.[1]) {
      errors.watch_page = html.includes("ytInitialPlayerResponse") ? "no_caption_tracks" : "blocked";
      return null;
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
      errors.watch_page = "parse_error";
      return null;
    }

    const tracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      errors.watch_page = "no_caption_tracks";
      return null;
    }

    const enTrack = tracks.find((t) => t.languageCode === "en") || tracks[0];
    const isAuto = enTrack.vssId?.startsWith("a.") || enTrack.kind === "asr";

    const transcriptResponse = await fetch(enTrack.baseUrl, { signal: AbortSignal.timeout(5000) });
    if (!transcriptResponse.ok) {
      errors.watch_page = classifyHttpStatus(transcriptResponse.status);
      return null;
    }

    const transcriptXml = await transcriptResponse.text();
    const segments = parseXmlSegments(transcriptXml);
    if (segments.length === 0) {
      errors.watch_page = "no_caption_tracks";
      return null;
    }

    return buildSuccess(videoId, title, enTrack.languageCode, isAuto, "watch_page", segments);
  } catch (err) {
    errors.watch_page = classifyFetchError(err);
    return null;
  }
}

async function tryPlayerResponse(videoId: string, errors: StrategyErrors): Promise<TranscriptSuccess | null> {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      errors.player_response = classifyHttpStatus(response.status);
      return null;
    }
    const html = await response.text();

    const ytInitialPlayerMatch = html.match(/(?:ytInitialPlayerResponse|var\s+ytInitialPlayerResponse)\s*=\s*(\{[\s\S]*?\});/);
    if (!ytInitialPlayerMatch?.[1]) {
      errors.player_response = "blocked";
      return null;
    }

    const playerResponse = JSON.parse(ytInitialPlayerMatch[1]);
    if (playerResponse?.playabilityStatus?.status === "ERROR") {
      errors.player_response = "blocked";
      return null;
    }

    const captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks as
        Array<{ baseUrl: string; languageCode?: string; kind?: string; vssId?: string }> | undefined;

    if (!captionTracks || captionTracks.length === 0) {
      errors.player_response = "no_caption_tracks";
      return null;
    }

    const title = playerResponse?.videoDetails?.title as string | undefined;
    const enTrack = captionTracks.find((t) => t.languageCode === "en") || captionTracks[0];
    const isAuto = enTrack.vssId?.startsWith("a.") || enTrack.kind === "asr";

    const transcriptResponse = await fetch(enTrack.baseUrl, { signal: AbortSignal.timeout(5000) });
    if (!transcriptResponse.ok) {
      errors.player_response = classifyHttpStatus(transcriptResponse.status);
      return null;
    }

    const transcriptXml = await transcriptResponse.text();
    const segments = parseXmlSegments(transcriptXml);
    if (segments.length === 0) {
      errors.player_response = "no_caption_tracks";
      return null;
    }

    return buildSuccess(videoId, title, enTrack.languageCode, isAuto, "player_response", segments);
  } catch (err) {
    errors.player_response = classifyFetchError(err);
    return null;
  }
}

async function tryTimedText(videoId: string, errors: StrategyErrors): Promise<TranscriptSuccess | null> {
  try {
    // Try multiple language variants
    const langVariants = ["en", "en-US", "en-GB", ""];
    const baseUrls: string[] = [];
    for (const lang of langVariants) {
      if (lang) {
        baseUrls.push(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`);
      } else {
        baseUrls.push(`https://www.youtube.com/api/timedtext?v=${videoId}`);
      }
    }

    let sawHttpFailure = false;
    for (const url of baseUrls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
          sawHttpFailure = true;
          errors.timedtext = classifyHttpStatus(response.status);
          continue;
        }
        const xml = await response.text();
        if (!/<text\s/.test(xml)) continue;

        const segments = parseXmlSegments(xml);
        if (segments.length > 0) {
          const langMatch = url.match(/lang=([^&]*)/);
          return buildSuccess(videoId, undefined, langMatch?.[1] || "en", false, "timedtext", segments);
        }
      } catch (err) {
        errors.timedtext = classifyFetchError(err);
        continue;
      }
    }
    if (!sawHttpFailure && !errors.timedtext) errors.timedtext = "no_caption_tracks";
  } catch (err) {
    errors.timedtext = classifyFetchError(err);
  }
  return null;
}

async function tryYtDlp(videoId: string, errors: StrategyErrors): Promise<TranscriptSuccess | null> {
  try {
    const { execSync } = await import("node:child_process");
    // Check if yt-dlp is available
    try {
      execSync("yt-dlp --version", { stdio: "ignore", timeout: 3000 });
    } catch {
      errors.yt_dlp = "language_unavailable";
      return null;
    }

    const tmpDir = path.resolve(process.cwd(), "data", "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const outFile = path.join(tmpDir, `ytdlp-${videoId}-${Date.now()}`);

    try {
      execSync(
        `yt-dlp --write-auto-sub --skip-download --sub-lang en -o "${outFile}" "https://www.youtube.com/watch?v=${videoId}"`,
        { stdio: "ignore", timeout: 15000 },
      );
    } catch {
      errors.yt_dlp = "no_caption_tracks";
      return null;
    }

    // Look for generated subtitle files
    const vttFile = `${outFile}.en.vtt`;
    const srtFile = `${outFile}.en.srt`;
    let subtitleContent = "";

    if (fs.existsSync(vttFile)) {
      subtitleContent = fs.readFileSync(vttFile, "utf-8");
      try { fs.unlinkSync(vttFile); } catch { /* ok */ }
    } else if (fs.existsSync(srtFile)) {
      subtitleContent = fs.readFileSync(srtFile, "utf-8");
      try { fs.unlinkSync(srtFile); } catch { /* ok */ }
    }

    if (!subtitleContent) {
      errors.yt_dlp = "no_caption_tracks";
      return null;
    }

    const segments = parseVttSegments(subtitleContent);
    if (segments.length === 0) {
      errors.yt_dlp = "parse_error";
      return null;
    }

    return buildSuccess(videoId, undefined, "en", true, "yt_dlp", segments);
  } catch (err) {
    errors.yt_dlp = classifyFetchError(err);
    return null;
  }
}

function parseVttSegments(vtt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = vtt.split("\n");
  let i = 0;

  // Skip header
  while (i < lines.length && !lines[i].includes("-->")) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("-->")) {
      const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (timeMatch) {
        const start = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
        const end = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;
        i++;
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() && !lines[i].includes("-->")) {
          const cleanLine = lines[i].replace(/<[^>]+>/g, "").trim();
          if (cleanLine) textLines.push(cleanLine);
          i++;
        }
        if (textLines.length > 0) {
          segments.push({ start, duration: end - start, text: textLines.join(" ") });
        }
        continue;
      }
    }
    i++;
  }

  return segments;
}

function parseXmlSegments(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)">([^<]*)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = match[3]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    if (text) {
      segments.push({ start: parseFloat(match[1]), duration: parseFloat(match[2]), text });
    }
  }
  return segments;
}

function buildSuccess(
  videoId: string,
  title: string | undefined,
  language: string | undefined,
  isGenerated: boolean,
  source: TranscriptStrategy,
  segments: TranscriptSegment[],
): TranscriptSuccess {
  const fullText = segments.map((s) => s.text).join(" ");
  const timestampedText = segments
    .map((s) => {
      const min = Math.floor(s.start / 60);
      const sec = Math.floor(s.start % 60);
      return `[${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}] ${s.text}`;
    })
    .join("\n");

  return {
    ok: true,
    videoId,
    title,
    language,
    isGenerated,
    source,
    segments,
    fullText,
    timestampedText,
    attempts: [],
  };
}

export async function fetchTranscriptRobust(url: string): Promise<TranscriptResult> {
  const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/i)?.[1];
  if (!videoId) {
    return { ok: false, errorCode: "invalid_url", attempts: [] };
  }

  const attempts: StrategyAttempt[] = [];
  const errors: StrategyErrors = {};

  // Strategy 1: Cache
  const t0 = Date.now();
  const cached = await tryCache(videoId);
  attempts.push({ strategy: "cache", ok: Boolean(cached), durationMs: Date.now() - t0 });
  if (cached) return { ...cached, attempts };

  // Strategy 2: Watch page caption track scrape
  const t1 = Date.now();
  const wp = await tryWatchPage(videoId, errors);
  attempts.push({ strategy: "watch_page", ok: Boolean(wp), errorCode: wp ? undefined : errors.watch_page ?? "no_caption_tracks", durationMs: Date.now() - t1 });
  if (wp) { saveCache(wp); return { ...wp, attempts }; }

  // Strategy 3: ytInitialPlayerResponse
  const t2 = Date.now();
  const pr = await tryPlayerResponse(videoId, errors);
  attempts.push({ strategy: "player_response", ok: Boolean(pr), errorCode: pr ? undefined : errors.player_response ?? "no_caption_tracks", durationMs: Date.now() - t2 });
  if (pr) { saveCache(pr); return { ...pr, attempts }; }

  // Strategy 4: Timed text API (with language variants)
  const t3 = Date.now();
  const tt = await tryTimedText(videoId, errors);
  attempts.push({ strategy: "timedtext", ok: Boolean(tt), errorCode: tt ? undefined : errors.timedtext ?? "no_caption_tracks", durationMs: Date.now() - t3 });
  if (tt) { saveCache(tt); return { ...tt, attempts }; }

  // Strategy 5: yt-dlp CLI fallback (if available)
  const t4 = Date.now();
  const ytdlp = await tryYtDlp(videoId, errors);
  attempts.push({ strategy: "yt_dlp", ok: Boolean(ytdlp), errorCode: ytdlp ? undefined : errors.yt_dlp ?? "no_caption_tracks", durationMs: Date.now() - t4 });
  if (ytdlp) { saveCache(ytdlp); return { ...ytdlp, attempts }; }

  const errorPriority: TranscriptFailure["errorCode"][] = ["blocked", "timeout", "network_error", "parse_error", "language_unavailable", "captions_disabled", "no_caption_tracks"];
  const finalError = errorPriority.find((code) => attempts.some((a) => a.errorCode === code)) ?? "no_caption_tracks";

  return {
    ok: false,
    videoId,
    errorCode: finalError,
    attempts,
  };
}

export function formatTranscriptResult(result: TranscriptResult): string {
  if (!result.ok) {
    const attemptSummary = result.attempts
      .map((a) => `${a.strategy}: ${a.ok ? "ok" : a.errorCode ?? "failed"} (${a.durationMs}ms)`)
      .join(", ");
    return JSON.stringify({
      ok: false,
      videoId: result.videoId ?? "unknown",
      errorCode: result.errorCode,
      attempts: result.attempts,
      summary: `Transcript unavailable. Attempted strategies: ${attemptSummary}.`,
    });
  }

  return JSON.stringify({
    ok: true,
    videoId: result.videoId,
    title: result.title,
    language: result.language,
    isGenerated: result.isGenerated ?? false,
    source: result.source,
    segmentCount: result.segments.length,
    durationApprox: result.segments.length > 0
      ? `${Math.round(result.segments[result.segments.length - 1].start)}s`
      : "unknown",
    attempts: result.attempts,
    fullText: result.fullText.slice(0, 30000),
    timestampedText: result.timestampedText.slice(0, 35000),
  });
}
