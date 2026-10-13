import { createHash } from "node:crypto";
import type { CaptureLevel } from "../types.js";

export const REDACTED_MAX_CHARS = 2048;
export const MASK = "[REDACTED]";

export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer [A-Za-z0-9._-]{20,}/g,
];

export type CapturedText = { text?: string; textDigest: string; textLength: number };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

/**
 * full -> text unchanged; redacted -> secrets masked then truncated to 2048 chars;
 * metadata -> text dropped. Digest and length always describe the original text.
 */
export function applyCapture(level: CaptureLevel, text: string): CapturedText {
  const textDigest = sha256Hex(text);
  const textLength = text.length;
  switch (level) {
    case "full":
      return { text, textDigest, textLength };
    case "redacted":
      return { text: maskSecrets(text).slice(0, REDACTED_MAX_CHARS), textDigest, textLength };
    case "metadata":
      return { textDigest, textLength };
  }
}
