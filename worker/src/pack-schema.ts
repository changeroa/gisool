import { ReleaseError } from "./r2-objects.ts";

export const phases = ["scope", "investigate", "verify", "handoff", "explain"] as const;
export type PackMember = { uri: string; phase: typeof phases[number]; selection: "required" | "when_applicable" | "when_requested"; when: string };
export type PackDefinition = { schema_version: 1; kind: "skill-pack"; name: string; display_name: string; description: string; scope: string; members: PackMember[] };
export const packUri = (name: string) => `pack://gisul/gisul/${name}`;
export function packName(uri: unknown): string {
  const match = typeof uri === "string" && /^pack:\/\/gisul\/gisul\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(uri);
  if (!match || match[1].length > 64) throw new ReleaseError("A canonical pack URI is required", 400);
  return match[1];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0");
export function validatePack(value: unknown, available?: ReadonlySet<string>): PackDefinition {
  if (!object(value) || !exact(value, ["schema_version", "kind", "name", "display_name", "description", "scope", "members"]) || value.schema_version !== 1 || value.kind !== "skill-pack" || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) || value.name.length > 64 || !text(value.display_name, 128) || !text(value.description, 2048) || !text(value.scope, 4096) || !Array.isArray(value.members) || value.members.length < 3 || value.members.length > 64) throw new ReleaseError("Invalid pack definition", 400);
  const seen = new Set<string>();
  for (const m of value.members) {
    if (!object(m) || !exact(m, ["uri", "phase", "selection", "when"]) || typeof m.uri !== "string" || !/^skill:\/\/gisul\/gisul\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/SKILL\.md$/.test(m.uri) || seen.has(m.uri) || !phases.includes(m.phase as typeof phases[number]) || !["required", "when_applicable", "when_requested"].includes(String(m.selection)) || !text(m.when, 2048)) throw new ReleaseError("Invalid or duplicate pack member", 400);
    seen.add(m.uri);
    if (available && !available.has(m.uri)) throw new ReleaseError(`Unavailable canonical skill reference: ${m.uri}`, 400);
  }
  for (const phase of ["scope", "verify"]) {
    const members = value.members.filter(m => m.phase === phase);
    if (members.length !== 1 || members[0].selection !== "required") throw new ReleaseError(`Pack requires exactly one required ${phase} member`, 400);
  }
  if (!value.members.some(m => m.phase === "investigate" && m.selection === "required")) throw new ReleaseError("Pack requires an investigation member", 400);
  return value as PackDefinition;
}
