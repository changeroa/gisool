// Ported from server/src/index.ts @48e7955
import type { SkillUri } from "../types.js";

export const SKILL_URI_AUTHORITY = "local";

/** skill://local/<rootId>/<dir...>/<relative...>, each path segment URI-encoded. */
export function skillUri(...segments: string[]): SkillUri {
  const parts = segments.flatMap((segment) => segment.split("/")).filter(Boolean);
  return `skill://${SKILL_URI_AUTHORITY}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

/** Parses a skill URI into its root id and path segments; returns null for anything malformed or traversing. */
export function parseSkillUri(uri: string): { rootId: string; segments: string[] } | null {
  if (typeof uri !== "string" || /%2f/i.test(uri) || uri.includes("\\")) return null;
  const authorityIndex = uri.indexOf("://");
  const rawPath = authorityIndex === -1 ? uri : uri.slice(authorityIndex + 3);
  if (rawPath.split("/").some((segment) => segment === ".." || segment === ".")) return null;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "skill:" || parsed.host !== SKILL_URI_AUTHORITY || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname || parsed.pathname === "/") return null;

  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length < 2) return null;
  const rootId = segments[0];
  if (!/^[A-Za-z0-9._-]+$/.test(rootId)) return null;
  for (const segment of segments.slice(1)) {
    if (segment === ".." || segment === "." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
  }
  if (skillUri(rootId, ...segments.slice(1)) !== uri) return null;
  return { rootId, segments: segments.slice(1) };
}
