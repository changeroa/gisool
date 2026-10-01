import { parse } from "yaml";
import { assertCommit, ReleaseError, sha256 } from "./r2-objects.ts";
import { decodeBlob, gitClient, repository, skillWrite, type GitCall, type TreeEntry, type WriteEnv } from "./skill-writer.ts";
import { packName, packUri, validatePack } from "./pack-schema.ts";
const definition = { type: "object", additionalProperties: false, required: ["schema_version", "kind", "name", "display_name", "description", "scope", "members"], properties: {
  schema_version: { type: "integer", const: 1 }, kind: { type: "string", const: "skill-pack" }, name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 },
  display_name: { type: "string", minLength: 1, maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: 2048 }, scope: { type: "string", minLength: 1, maxLength: 4096 },
  members: { type: "array", minItems: 3, maxItems: 64, description: "Exactly one required scope and verify member and at least one required investigation member. Flat canonical skill references only.", items: { type: "object", additionalProperties: false, required: ["uri", "phase", "selection", "when"], properties: {
    uri: { type: "string" }, phase: { type: "string", enum: ["scope", "investigate", "verify", "handoff", "explain"] }, selection: { type: "string", enum: ["required", "when_applicable", "when_requested"] }, when: { type: "string", minLength: 1, maxLength: 2048 }
  } } }
} };
const annotation = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const packWriteTools = [
  { name: "create_pack", description: "Create a native pack JSON resource in canonical Git, validating all skill references. User-requested writes only. Returns accepted until gated publication; use get_pack_write_status then load_pack to verify exact live bytes.", inputSchema: { type: "object", additionalProperties: false, required: ["definition"], properties: { definition } }, annotations: annotation },
  { name: "update_pack", description: "Update a previously loaded native pack with its expected_digest. Stale Git contents conflict; reload and reconcile. Does not copy or update member skill bodies. Accepted does not mean published.", inputSchema: { type: "object", additionalProperties: false, required: ["uri", "definition", "expected_digest"], properties: { uri: { type: "string" }, definition, expected_digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } } }, annotations: { ...annotation, destructiveHint: true } },
  { name: "get_pack_write_status", description: "Check an accepted pack commit against active publication. A newer release may contain subsequent edits; load_pack to verify the current definition.", inputSchema: { type: "object", additionalProperties: false, required: ["commit"], properties: { commit: { type: "string", pattern: "^[a-f0-9]{40}$" } } }, annotations: { ...annotation, readOnlyHint: true } },
];
export async function packWrite(env: WriteEnv, tool: string, input: unknown, git: GitCall = gitClient(env)): Promise<Record<string, unknown>> {
  if (!env.GISUL_GITHUB_TOKEN) throw new ReleaseError("Pack writing is not configured", 503);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReleaseError("Expected pack arguments", 400);
  const args = input as Record<string, unknown>;
  const spec = packWriteTools.find(t => t.name === tool);
  if (!spec || Object.keys(args).some(k => !Object.hasOwn(spec.inputSchema.properties, k))) throw new ReleaseError("Unknown pack tool or argument", 400);
  if (tool === "get_pack_write_status") return skillWrite(env, "get_skill_write_status", args, git);
  const pack = validatePack(args.definition);
  const uri = packUri(pack.name), path = `packs/${pack.name}.json`;
  if (tool === "update_pack" && (packName(args.uri) !== pack.name || typeof args.expected_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(args.expected_digest))) throw new ReleaseError("Pack URI/name and expected_digest are required", 400);
  const head = (await git("/git/ref/heads/main")).object.sha;
  assertCommit(head);
  const parent = await git(`/git/commits/${head}`);
  const tree = await git(`/git/trees/${parent.tree.sha}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new ReleaseError("Cannot inspect the complete Git tree", 502);
  const entries: TreeEntry[] = tree.tree;
  const existing = entries.find(e => e.path === path);
  if (tool === "create_pack" && existing) throw new ReleaseError("Pack already exists in Git; inspect publication before retrying", 409);
  if (tool === "update_pack" && (!existing || existing.type !== "blob" || existing.mode !== "100644")) throw new ReleaseError("Pack does not exist as a regular JSON file", 404);
  const content = JSON.stringify(pack, null, 2) + "\n";
  if (existing) {
    const old = decodeBlob(await git(`/git/blobs/${existing.sha}`));
    if (await sha256(old) !== args.expected_digest) throw new ReleaseError("Pack changed since load; reload and reconcile", 409);
    if (old === content) return { status: "unchanged", commit: head, uri, digest: args.expected_digest };
  }
  // Validate against the exact Git parent, including pending skill changes. Publication
  // validates closure again; never mix mutable main with an unrelated R2 snapshot.
  for (const member of pack.members) {
    const skillPath = `skills/${member.uri.slice("skill://gisul/gisul/".length)}`;
    const file = entries.find(e => e.path === skillPath && e.type === "blob" && ["100644", "100755"].includes(e.mode));
    if (!file) throw new ReleaseError(`Unavailable canonical skill reference: ${member.uri}`, 400);
    const body = decodeBlob(await git(`/git/blobs/${file.sha}`));
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
    let meta;
    try { meta = match && parse(match[1]); } catch { throw new ReleaseError("Invalid referenced skill frontmatter", 400); }
    if (meta?.name !== member.uri.split("/").at(-2) || typeof meta?.description !== "string" || !meta.description.trim()) throw new ReleaseError(`Invalid referenced skill: ${member.uri}`, 400);
  }
  const nextTree = await git("/git/trees", "POST", { base_tree: parent.tree.sha, tree: [{ path, mode: "100644", type: "blob", content }] });
  const commit = await git("/git/commits", "POST", { message: `${tool === "create_pack" ? "Add" : "Update"} ${pack.name} native pack via authenticated MCP`, tree: nextTree.sha, parents: [head] });
  assertCommit(commit.sha);
  try { await git("/git/refs/heads/main", "PATCH", { sha: commit.sha, force: false }); }
  catch (error) {
    if ((await git("/git/ref/heads/main")).object.sha !== commit.sha) throw new ReleaseError(`Pack write not confirmed; inspect commit ${commit.sha} and main before retrying`, 409);
  }
  return { status: "accepted", commit: commit.sha, uri, digest: await sha256(content), url: `https://github.com/${repository(env)}/commit/${commit.sha}`, note: "Saved to Git; publication is asynchronous. Check get_pack_write_status, then load_pack and verify the live definition." };
}
