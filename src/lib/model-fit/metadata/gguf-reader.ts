import fs from "node:fs";

/**
 * Minimal, safe GGUF metadata reader. Reads ONLY the header + metadata key/value
 * table — never tensor payloads. Large array values (e.g. tokenizer vocab) are
 * skipped without being materialized. Bounded by a hard read cap and per-string
 * length cap, with clean failure on malformed files.
 *
 * GGUF layout: magic "GGUF" (u32) | version (u32) | tensor_count (u64) |
 * metadata_kv_count (u64) | KV pairs. Value types: 0..12 (see GGUF_TYPE).
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian
const READ_CAP_BYTES = 96 * 1024 * 1024; // never read more than 96MB of header region
const MAX_STRING_LEN = 1 * 1024 * 1024; // 1MB per string value
const MAX_KV = 4096;

export type GgufValue = number | bigint | boolean | string | { array: true; elementType: number; length: number };

export type GgufMetadata = {
  version: number;
  tensorCount: number;
  metadataKvCount: number;
  kv: Record<string, GgufValue>;
  truncated: boolean;
};

const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const;

const FIXED_SIZE: Record<number, number> = {
  [T.UINT8]: 1, [T.INT8]: 1, [T.UINT16]: 2, [T.INT16]: 2, [T.UINT32]: 4,
  [T.INT32]: 4, [T.FLOAT32]: 4, [T.BOOL]: 1, [T.UINT64]: 8, [T.INT64]: 8, [T.FLOAT64]: 8,
};

class Cursor {
  private buf: Buffer;
  private end: number;
  pos = 0;
  truncated = false;

  constructor(private fd: number, private fileSize: number) {
    const initial = Math.min(fileSize, 4 * 1024 * 1024);
    this.buf = Buffer.alloc(initial);
    this.end = fs.readSync(fd, this.buf, 0, initial, 0);
  }

  private ensure(need: number): void {
    if (this.pos + need <= this.end) return;
    const want = Math.min(this.fileSize, Math.max(this.pos + need, this.end * 2));
    if (want > READ_CAP_BYTES) {
      this.truncated = true;
      throw new RangeError("GGUF header exceeds read cap");
    }
    if (want > this.buf.length) {
      const next = Buffer.alloc(want);
      this.buf.copy(next, 0, 0, this.end);
      this.buf = next;
    }
    this.end += fs.readSync(this.fd, this.buf, this.end, want - this.end, this.end);
    if (this.pos + need > this.end) throw new RangeError("Unexpected end of GGUF header");
  }

  u32(): number { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32(): number { this.ensure(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64(): number { this.ensure(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  i64(): number { this.ensure(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return Number(v); }
  f32(): number { this.ensure(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64(): number { this.ensure(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  u8(): number { this.ensure(1); return this.buf[this.pos++]; }
  bool(): boolean { return this.u8() !== 0; }
  skip(n: number): void { this.ensure(Math.min(n, 1)); this.pos += n; if (this.pos > this.fileSize) throw new RangeError("skip past EOF"); }

  str(): string {
    const len = this.u64();
    if (len > MAX_STRING_LEN) { this.skip(len); return "[oversized-string]"; }
    this.ensure(len);
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

function readScalar(c: Cursor, type: number): GgufValue {
  switch (type) {
    case T.UINT8: return c.u8();
    case T.INT8: { const v = c.u8(); return v > 127 ? v - 256 : v; }
    case T.UINT16: { c.skip(0); return readU16(c); }
    case T.INT16: return readI16(c);
    case T.UINT32: return c.u32();
    case T.INT32: return c.i32();
    case T.FLOAT32: return c.f32();
    case T.BOOL: return c.bool();
    case T.STRING: return c.str();
    case T.UINT64: return c.u64();
    case T.INT64: return c.i64();
    case T.FLOAT64: return c.f64();
    default: throw new RangeError(`Unsupported GGUF scalar type ${type}`);
  }
}

function readU16(c: Cursor): number { const a = c.u8(); const b = c.u8(); return a | (b << 8); }
function readI16(c: Cursor): number { const v = readU16(c); return v > 32767 ? v - 65536 : v; }

function skipArray(c: Cursor, elementType: number, length: number): void {
  if (elementType === T.STRING) {
    for (let i = 0; i < length; i += 1) c.str();
    return;
  }
  if (elementType === T.ARRAY) {
    for (let i = 0; i < length; i += 1) {
      const innerType = c.u32();
      const innerLen = c.u64();
      skipArray(c, innerType, innerLen);
    }
    return;
  }
  const size = FIXED_SIZE[elementType];
  if (size === undefined) throw new RangeError(`Unsupported GGUF array element type ${elementType}`);
  c.skip(size * length);
}

export function readGgufMetadata(filePath: string): GgufMetadata {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Not a file");
  if (stat.size < 24) throw new Error("File too small to be GGUF");
  const fd = fs.openSync(filePath, "r");
  try {
    const c = new Cursor(fd, stat.size);
    const magic = c.u32();
    if (magic !== GGUF_MAGIC) throw new Error("Not a GGUF file (bad magic)");
    const version = c.u32();
    if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version ${version}`);
    const tensorCount = c.u64();
    const metadataKvCount = c.u64();
    if (metadataKvCount > MAX_KV) throw new Error(`Too many metadata entries: ${metadataKvCount}`);

    const kv: Record<string, GgufValue> = {};
    let truncated = false;
    for (let i = 0; i < metadataKvCount; i += 1) {
      const key = c.str();
      const type = c.u32();
      if (type === T.ARRAY) {
        const elementType = c.u32();
        const length = c.u64();
        // Record array shape, skip the payload (e.g. tokenizer vocab).
        kv[key] = { array: true, elementType, length };
        skipArray(c, elementType, length);
      } else {
        kv[key] = readScalar(c, type);
      }
    }
    return { version, tensorCount, metadataKvCount, kv, truncated };
  } catch (error) {
    if (error instanceof RangeError) {
      // Return a partial-but-flagged result rather than throwing on truncation cap.
      return { version: 0, tensorCount: 0, metadataKvCount: 0, kv: {}, truncated: true };
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
