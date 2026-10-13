// Ported from server/src/index.ts @48e7955
import { parse as parseYaml } from "yaml";
import type { SkillEntry } from "../types.js";

export const BODY_HEAD_MAX = 600;

/** Splits SKILL.md into YAML frontmatter (object) and body; frontmatter is null when absent or invalid. */
export function splitSkillMarkdown(input: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const markdown = input.replace(/\r\n/g, "\n");
  if (!markdown.startsWith("---\n")) return { frontmatter: null, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: null, body: markdown };
  const afterDelimiter = markdown.slice(end + 4, end + 5);
  if (afterDelimiter !== "" && afterDelimiter !== "\n") return { frontmatter: null, body: markdown };
  const body = markdown.slice(end + 5);

  let parsed: unknown;
  try {
    parsed = parseYaml(markdown.slice(4, end));
  } catch {
    return { frontmatter: null, body };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { frontmatter: null, body };
  return { frontmatter: parsed as Record<string, unknown>, body };
}

/** Accepts a YAML list of strings or a comma-separated string; anything else yields []. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function explicitGroup(value: unknown): { id: string; stage?: string } | undefined {
  if (typeof value === "string" && value.trim()) return { id: value.trim() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  const stage = typeof record.stage === "string" && record.stage.trim() ? record.stage.trim() : typeof record.stage === "number" ? String(record.stage) : undefined;
  return stage === undefined ? { id: record.id.trim() } : { id: record.id.trim(), stage };
}

/** First non-heading paragraph of the body, whitespace-collapsed, at most BODY_HEAD_MAX chars. */
export function bodyHead(body: string): string {
  let inFence = false;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    if (/^\s{0,3}#/.test(line)) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    current.push(line.trim());
    if (current.join(" ").length > BODY_HEAD_MAX) break;
  }
  if (current.length) paragraphs.push(current.join(" "));
  const first = paragraphs.find((p) => p.trim()) ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, BODY_HEAD_MAX);
}

export type SkillFields = Pick<SkillEntry, "name" | "description" | "tags" | "whenToUse" | "examples" | "aliasesKo" | "group" | "invocation" | "bodyHead">;

/** Extracts the routing fields; returns null when name or description is missing. */
export function extractFields(frontmatter: Record<string, unknown>, body: string): SkillFields | null {
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !name || typeof description !== "string" || !description) return null;
  const whenRaw = frontmatter.when_to_use ?? frontmatter["when-to-use"];
  const fields: SkillFields = {
    name,
    description,
    tags: stringList(frontmatter.tags),
    examples: stringList(frontmatter.examples),
    aliasesKo: stringList(frontmatter.aliases_ko),
    invocation: frontmatter["disable-model-invocation"] === true || frontmatter["disable-model-invocation"] === "true" ? "explicit" : "automatic",
    bodyHead: bodyHead(body),
  };
  if (typeof whenRaw === "string" && whenRaw.trim()) fields.whenToUse = whenRaw.trim();
  const group = explicitGroup(frontmatter.group);
  if (group) fields.group = group;
  return fields;
}

/** Family id derived from a name: the prefix before the first "-" (the whole name when there is none). */
export function familyPrefix(name: string): string {
  const index = name.indexOf("-");
  return index === -1 ? name : name.slice(0, index);
}

/**
 * Assigns derived groups (prefix families with >= 2 distinct names) to entries lacking an explicit group,
 * and returns every family: explicit groups plus derived prefix families, uris sorted.
 */
export function applyFamilies(entries: SkillEntry[], explicit: Map<string, { id: string; stage?: string } | undefined>): { id: string; uris: string[] }[] {
  const namesByPrefix = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (explicit.get(entry.uri)) continue;
    const prefix = familyPrefix(entry.name);
    if (!namesByPrefix.has(prefix)) namesByPrefix.set(prefix, new Set());
    namesByPrefix.get(prefix)!.add(entry.name);
  }
  const families = new Map<string, string[]>();
  for (const entry of entries) {
    const group = explicit.get(entry.uri);
    if (group) {
      entry.group = group;
    } else {
      const prefix = familyPrefix(entry.name);
      if ((namesByPrefix.get(prefix)?.size ?? 0) >= 2) entry.group = { id: prefix };
      else delete entry.group;
    }
    if (entry.group) {
      if (!families.has(entry.group.id)) families.set(entry.group.id, []);
      families.get(entry.group.id)!.push(entry.uri);
    }
  }
  return [...families.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, uris]) => ({ id, uris: uris.sort() }));
}
