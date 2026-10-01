import { searchSkills, type SearchMode } from "../../server/src/skill-search.ts";
import { manifestDigest, readSnapshot } from "./release-reader.ts";
import { readCurrent, readVerifiedObject, releaseKey, ReleaseError } from "./r2-objects.ts";
import { packName, phases, type PackMember } from "./pack-schema.ts";

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const commit = { type: "string", pattern: "^[a-f0-9]{40}$" };
export const packReadTools = [
  { name: "search_packs", description: "Discover native skill packs by subject/outcome. Results are candidates, not activated workflows. Returns membership roles, conditions, attribution and a catalog commit. Load selected packs with that commit; do not load every candidate's skills.", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 2048 }, mode: { type: "string", enum: ["discovery", "explicit"] }, commit, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, annotations },
  { name: "load_pack", description: "Load one or combine up to 8 selected native packs from one immutable commit, without loading skill bodies or executing them. Returns deduplicated members retaining every pack's condition/scenario. Choose conditional members with reasons, honor explicit invocation, then load selected skills with the returned commit. Record actual loads, exclusions, evidence and uncovered scope; a load is not a completed review.", inputSchema: { type: "object", additionalProperties: false, required: ["uris"], properties: { uris: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } }, commit } }, annotations },
];
const unknownRegistration = { created_by: null, created_at: null, updated_by: null, updated_at: null };
export async function packRead(bucket: R2Bucket, name: string, input: unknown, origin: string, serverVersion: string): Promise<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReleaseError("Expected pack arguments", 400);
  const args = input as Record<string, unknown>;
  const tool = packReadTools.find(t => t.name === name);
  if (!tool || Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k))) throw new ReleaseError("Unknown pack tool or argument", 400);
  const snapshot = await readSnapshot(bucket, args.commit);
  const active = await readCurrent(bucket);
  const publication_status = active?.value.commit === snapshot.identity.commit ? "published" : "verified_snapshot";
  const meta = { origin, release: snapshot.identity.release, commit: snapshot.identity.commit, server_version: serverVersion, publication_status, active_commit: active?.value.commit ?? null };
  const packs = snapshot.inventory.packs ?? [];
  if (name === "search_packs") {
    const { query, offset = 0, limit = 5, mode = "discovery" } = args;
    if ((query !== undefined && (typeof query !== "string" || query.length > 2048)) || (mode !== "discovery" && mode !== "explicit") || (mode === "discovery" && !(query as string | undefined)?.trim()) || !Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new ReleaseError("Invalid pack search arguments", 400);
    const matches = searchSkills(packs.map(p => ({ uri: p.uri, name: p.definition.name, description: p.definition.description, keywords: [p.definition.display_name, p.definition.scope, ...p.definition.members.map(m => m.uri.split("/").at(-2)!)], automatic: true, digest: p.digest })), query as string | undefined, mode as SearchMode);
    const found = matches.slice(offset as number, (offset as number) + (limit as number)).map(m => {
      const p = packs.find(p => p.uri === m.uri)!;
      return { uri: p.uri, kind: "skill-pack", name: p.definition.name, display_name: p.definition.display_name, description: p.definition.description, members: p.definition.members, digest: p.digest, ...(p.registration ?? unknownRegistration), publication_status, active_commit: active?.value.commit ?? null };
    });
    return { ...meta, packs: found, totalMatches: matches.length, offset, limit, ...((offset as number) + found.length < matches.length ? { nextOffset: (offset as number) + found.length } : {}) };
  }
  if (!Array.isArray(args.uris) || args.uris.length < 1 || args.uris.length > 8 || new Set(args.uris).size !== args.uris.length) throw new ReleaseError("Select 1–8 unique pack URIs", 400);
  const selected = args.uris.map(uri => {
    packName(uri);
    const p = packs.find(p => p.uri === uri);
    if (!p) throw new ReleaseError(`Unknown pack URI: ${uri}`, 404);
    return p;
  });
  for (const p of selected) {
    const bytes = await readVerifiedObject(bucket, releaseKey(snapshot.identity.commit, `packs/${p.definition.name}.json`), p);
    const actual = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, ordered(value)])) : v;
    if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(p.definition))) throw new ReleaseError("Pack bytes differ from verified definition");
  }
  const members = new Map<string, { uri: string; phase: PackMember["phase"]; required: boolean; invocation: string; digest: string; manifest_digest: string; commit: string; requirements: Array<PackMember & { pack_uri: string }> }>();
  for (const p of selected) for (const m of p.definition.members) {
    const existing = members.get(m.uri);
    if (existing && existing.phase !== m.phase) throw new ReleaseError(`Conflicting member phases for ${m.uri}`, 409);
    const skill = snapshot.inventory.skills.find(s => s.uri === m.uri)!;
    const record = existing ?? { uri: m.uri, phase: m.phase, required: false, invocation: skill.frontmatter["disable-model-invocation"] === true ? "explicit" : "automatic", digest: skill.resources.find(r => r.uri === m.uri)!.digest, manifest_digest: await manifestDigest(skill), commit: snapshot.identity.commit, requirements: [] };
    record.required ||= m.selection === "required";
    record.requirements.push({ ...m, pack_uri: p.uri });
    members.set(m.uri, record);
  }
  for (const phase of ["scope", "verify"]) if ([...members.values()].filter(m => m.phase === phase).length !== 1) throw new ReleaseError(`Combined packs require one shared ${phase} member`, 409);
  return { ...meta, packs: selected.map(p => ({ ...p, ...(p.registration ?? unknownRegistration), version: snapshot.identity.commit })), members: [...members.values()].sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase)), composition: { declared_members: selected.reduce((n, p) => n + p.definition.members.length, 0), unique_members: members.size, single_scope_and_verifier: true, load_selected_bodies_only: true }, permissions: { grants_execution: false, grants_delegation: false, grants_publication: false }, guidance: "Selection does not activate skills. Required members still obey explicit invocation and task permissions; report unavailable activation as incomplete coverage. Evaluate every retained condition, record selections/exclusions and load only chosen bodies with this commit. Share one evidence index and verifier; retain each pack's scenario coverage. Preserve native UI evidence and handoff context. No workflow or execution success is claimed by this response." };
}
