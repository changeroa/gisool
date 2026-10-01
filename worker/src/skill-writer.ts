import { parse } from "yaml";
import { assertCommit, readCurrent, ReleaseError, sha256 } from "./r2-objects.ts";
import { canonicalUri } from "./release-reader.ts";

export interface WriteEnv {
  SKILLS_BUCKET: R2Bucket;
  GISUL_GITHUB_TOKEN?: string;
  GISUL_WRITE_TOKEN?: string;
  GISUL_SKILLS_REPOSITORY?: string;
  GISUL_PUBLISH_WORKFLOW?: string;
}
export function repository(env: WriteEnv): string {
  const value = env.GISUL_SKILLS_REPOSITORY ?? "changeroa/gisul-skills";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new ReleaseError("Invalid skill repository configuration", 503);
  return value;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const namePattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const digestPattern = "^sha256:[a-f0-9]{64}$";
const textSchema = { type: "string", minLength: 1, maxLength: 512 * 1024 };
export const writeTools = [
  { name: "create_skill", description: "Create a skill and optional supporting text files in canonical Git main. Returns accepted, not published; inspect get_skill_write_status and reload after publication. Never overwrites existing skills.", inputSchema: { type: "object", required: ["name", "markdown"], additionalProperties: false, properties: { name: { type: "string", pattern: namePattern, maxLength: 64 }, source: { type: "string", enum: ["gisul"] }, markdown: textSchema, files: { type: "object", maxProperties: 127, additionalProperties: { type: "string" } } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "update_skill", description: "Update SKILL.md in canonical Git main using a previously loaded expected_digest. Preserves supporting files. Returns accepted until gated publication completes. Conflicts require reload and reconciliation.", inputSchema: { type: "object", required: ["uri", "markdown", "expected_digest"], additionalProperties: false, properties: { uri: { type: "string" }, markdown: textSchema, expected_digest: { type: "string", pattern: digestPattern } } }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: "get_skill_write_status", description: "Check a returned Git commit against the active release and publication workflow. Accepted or a successful workflow alone does not mean published.", inputSchema: { type: "object", required: ["commit"], additionalProperties: false, properties: { commit: { type: "string", pattern: "^[a-f0-9]{40}$" } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
];

export type TreeEntry = { path: string; type: string; mode: string; sha: string };
export type GitCall = (path: string, method?: string, body?: unknown) => Promise<any>;
export function gitClient(env: WriteEnv): GitCall {
  const apiRoot = `https://api.github.com/repos/${repository(env)}`;
  return async (path, method = "GET", body) => {
    let response: Response;
    try {
      response = await fetch(`${apiRoot}${path}`, { method, headers: { authorization: `Bearer ${env.GISUL_GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "gisul-worker", "x-github-api-version": "2022-11-28" }, redirect: "manual", signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      console.error("GitHub transport failed", { method, path, reason: error instanceof Error ? error.message : "unknown" });
      throw new ReleaseError(`GitHub request outcome is unknown (${method} ${path}); inspect main before retrying a write`, 502);
    }
    if (response.status === 403 || response.status === 404) throw new ReleaseError("GitHub did not allow this repository operation. Check the connected account's repository access, App installation, or branch protection; repeated retries will not grant permission.", 403);
    if (!response.ok) throw new ReleaseError([409, 422].includes(response.status) ? "Git changed concurrently or rejected the write; reload and reconcile before retrying" : `GitHub request failed (${response.status})`, [409, 422].includes(response.status) ? 409 : 502);
    return response.json();
  };
}
function markdownName(markdown: unknown, expected: string): asserts markdown is string {
  if (typeof markdown !== "string" || new TextEncoder().encode(markdown).length > 512 * 1024 || markdown.includes("\0")) throw new ReleaseError("Invalid or oversized Markdown", 400);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  let meta: unknown;
  try { meta = match && parse(match[1]); } catch { throw new ReleaseError("Invalid YAML frontmatter", 400); }
  if (!object(meta) || meta.name !== expected || typeof meta.description !== "string" || !meta.description.trim()) throw new ReleaseError("Frontmatter name must match the skill and description must be nonempty", 400);
}
function supportingPath(path: string): boolean {
  return /^(references|scripts|assets|agents)\/[A-Za-z0-9_./-]+$/.test(path) && path.split("/").every(part => !!part && !part.startsWith(".") && part !== "node_modules") && !path.endsWith("/SKILL.md");
}
export function decodeBlob(blob: { encoding: string; content: string }): string {
  if (blob.encoding !== "base64") throw new ReleaseError("Unexpected Git blob encoding", 502);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(blob.content.replace(/\s/g, "")), c => c.charCodeAt(0)));
}

export async function skillWrite(env: WriteEnv, tool: string, args: unknown, git: GitCall = gitClient(env)): Promise<Record<string, unknown>> {
  const webRoot = `https://github.com/${repository(env)}`;
  if (!env.GISUL_GITHUB_TOKEN) throw new ReleaseError("Skill writing is not configured", 503);
  if (!object(args)) throw new ReleaseError("Tool arguments must be an object", 400);
  if (tool === "get_skill_write_status") {
    assertCommit(args.commit);
    const current = await readCurrent(env.SKILLS_BUCKET);
    const identity = current?.value;
    if (identity?.commit === args.commit) return { status: "published", commit: args.commit, release: identity.release };
    if (identity) {
      const comparison = await git(`/compare/${args.commit}...${identity.commit}`);
      if (comparison.status === "ahead") return { status: "included_in_published_release", commit: args.commit, current_commit: identity.commit, release: identity.release, note: "Reload the skill to verify its current content; later commits may have changed it." };
    }
    const workflow = env.GISUL_PUBLISH_WORKFLOW ?? "publish-r2.yml";
    if (!/^[A-Za-z0-9_-]+\.ya?ml$/.test(workflow)) throw new ReleaseError("Invalid publication workflow configuration", 503);
    const runs = await git(`/actions/workflows/${workflow}/runs?head_sha=${args.commit}&per_page=10`);
    const run = runs.workflow_runs?.[0];
    return { status: run?.status === "completed" ? (run.conclusion === "success" ? "not_current" : "publication_failed") : "pending", commit: args.commit, workflow_status: run?.status ?? "not_started", conclusion: run?.conclusion ?? null, url: run?.html_url ?? `${webRoot}/actions/workflows/${workflow}` };
  }
  if (!["create_skill", "update_skill"].includes(tool)) throw new ReleaseError("Unknown write tool", 400);
  let name: string;
  if (tool === "create_skill") {
    if (typeof args.name !== "string" || args.name.length > 64 || !new RegExp(namePattern).test(args.name) || (args.source !== undefined && args.source !== "gisul")) throw new ReleaseError("Invalid skill name or source", 400);
    name = args.name;
  } else {
    const uri = canonicalUri(args.uri);
    const match = /^skill:\/\/gisul\/gisul\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(uri);
    if (!match || typeof args.expected_digest !== "string" || !new RegExp(digestPattern).test(args.expected_digest)) throw new ReleaseError("A canonical skill URI and expected_digest are required", 400);
    if (args.files !== undefined) throw new ReleaseError("Update changes SKILL.md only; supporting files are preserved", 400);
    name = match[1];
  }
  markdownName(args.markdown, name);
  const root = `skills/${name}/`;
  const changes = new Map<string, string>([[`${root}SKILL.md`, args.markdown]]);
  if (args.files !== undefined) {
    if (!object(args.files) || Object.keys(args.files).length > 127) throw new ReleaseError("Invalid supporting files", 400);
    for (const [path, contents] of Object.entries(args.files)) {
      if (!supportingPath(path) || typeof contents !== "string" || contents.includes("\0")) throw new ReleaseError("Invalid supporting file path or contents", 400);
      changes.set(root + path, contents);
    }
  }
  if ([...changes.values()].reduce((n, s) => n + new TextEncoder().encode(s).length, 0) > 768 * 1024) throw new ReleaseError("Skill write exceeds 768 KiB", 400);
  const head = (await git("/git/ref/heads/main")).object.sha as string;
  assertCommit(head);
  const parent = await git(`/git/commits/${head}`);
  const tree = await git(`/git/trees/${parent.tree.sha}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new ReleaseError("Cannot safely inspect the complete Git tree", 502);
  const entries: TreeEntry[] = tree.tree;
  const existing = entries.find(entry => entry.path === `${root}SKILL.md`);
  if (tool === "create_skill" && entries.some(entry => entry.path === root.slice(0, -1) || entry.path.startsWith(root))) throw new ReleaseError("Skill already exists in Git; inspect its publication status before retrying or updating", 409);
  if (tool === "update_skill") {
    if (!existing || existing.type !== "blob" || !["100644", "100755"].includes(existing.mode)) throw new ReleaseError("Skill does not exist as a regular file", 404);
    const old = decodeBlob(await git(`/git/blobs/${existing.sha}`));
    if (await sha256(old) !== args.expected_digest) throw new ReleaseError("Skill changed since load; reload and reconcile. A newer Git change may still be publishing", 409);
    if (old === args.markdown) return { status: "unchanged", commit: head, uri: args.uri, digest: args.expected_digest, note: "Check publication status; unchanged Git bytes do not prove they are live." };
  }
  const files = new Set([...entries.filter(e => e.type === "blob" && ["100644", "100755"].includes(e.mode)).map(e => e.path), ...changes.keys()]);
  for (const match of args.markdown.matchAll(/\[[^\]]*\]\(<?((?:\.\/)?(?:references|scripts|assets|agents)\/[^\s)>]+)>?\)/g)) {
    const target = match[1].replace(/^\.\//, "").split("#")[0];
    if (!supportingPath(target) || ![...files].some(file => file === root + target || file.startsWith(root + target + "/"))) throw new ReleaseError(`Missing or invalid supporting reference: ${target}`, 400);
  }
  const nextTree = await git("/git/trees", "POST", { base_tree: parent.tree.sha, tree: [...changes].map(([path, content]) => ({ path, mode: path === existing?.path ? existing.mode : "100644", type: "blob", content })) });
  const commit = await git("/git/commits", "POST", { message: `${tool === "create_skill" ? "Add" : "Update"} ${name} skill via authenticated MCP`, tree: nextTree.sha, parents: [head] });
  assertCommit(commit.sha);
  try { await git("/git/refs/heads/main", "PATCH", { sha: commit.sha, force: false }); }
  catch (error) {
    // A response may be lost after GitHub accepted the update. Read before any retry.
    const actual = (await git("/git/ref/heads/main")).object.sha;
    if (actual !== commit.sha) throw new ReleaseError(`Write not confirmed; inspect commit ${commit.sha} and main before retrying. ${error instanceof ReleaseError ? error.message : "Git update failed"}`, error instanceof ReleaseError ? error.status : 502);
  }
  return { status: "accepted", commit: commit.sha, uri: `skill://gisul/gisul/${name}/SKILL.md`, digest: await sha256(args.markdown), files: changes.size, url: `${webRoot}/commit/${commit.sha}`, note: "Saved to canonical Git main. Publication runs validation and integrity checks asynchronously; call get_skill_write_status, then load_skill to verify the published bytes." };
}
