import crypto from "node:crypto";

export function timingSafeStringEqual(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const left = Buffer.from(String(actual ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
