export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(maxBytes: number, actualBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

function getDeclaredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function ensureWithinCap(request: Request, actualBytes: number, maxBytes: number): void {
  const declared = getDeclaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes, declared);
  }
  if (actualBytes > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes, actualBytes);
  }
}

export async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const text = await request.text();
  ensureWithinCap(request, Buffer.byteLength(text, "utf8"), maxBytes);
  return text;
}

export async function readCappedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const text = await readCappedText(request, maxBytes);
  return JSON.parse(text) as T;
}
