import { packUri, validatePack, type PackDefinition } from "./pack-schema.ts";
import { assertCommit, assertDigest, readCurrent, readVerifiedObject, releaseKey, ReleaseError, sha256 } from "./r2-objects.ts";
import type { FileDigest, ReleaseIdentity } from "./r2-objects.ts";

export type SkillResource = FileDigest & { uri: string };
export type SkillRegistration = { created_by: string; created_at: string; updated_by: string; updated_at: string };
export type SkillEntry = { uri: string; frontmatter: Record<string, unknown> & { name: string; description: string }; resources: SkillResource[]; registration?: SkillRegistration };
export type PackEntry = { uri: string; definition: PackDefinition; digest: string; size: number; registration?: SkillRegistration };
export type ReleaseFile = FileDigest & { path: string; uri?: string };
export type ReleaseInventory = {
  schema_version: 1;
  commit: string;
  release: string;
  skills: SkillEntry[];
  packs?: PackEntry[];
  files: ReleaseFile[];
  aliases: Record<string, string>;
};
export type Snapshot = { identity: ReleaseIdentity; inventory: ReleaseInventory; files: Map<string, ReleaseFile> };

export function canonicalUri(uri: unknown): string {
  if (typeof uri !== "string" || /%2e|%2f|%5c|%00/i.test(uri) || uri.includes("\\")) throw new ReleaseError("Invalid skill URI", 400);
  let url: URL;
  try { url = new URL(uri); } catch { throw new ReleaseError("Invalid skill URI", 400); }
  if (url.protocol !== "skill:" || url.host !== "gisul" || url.username || url.password || url.search || url.hash) throw new ReleaseError("Invalid skill URI", 400);
  let segments: string[];
  try { segments = url.pathname.slice(1).split("/").map(decodeURIComponent); } catch { throw new ReleaseError("Invalid skill URI", 400); }
  if (segments.length < 2 || segments.some(part => !part || part === "." || part === ".." || /[\\/\x00-\x1f\x7f]/.test(part)) || `skill://gisul/${segments.map(encodeURIComponent).join("/")}` !== uri) throw new ReleaseError("Noncanonical skill URI", 400);
  return uri;
}

export async function manifestDigest(entry: SkillEntry): Promise<string> {
  return sha256(JSON.stringify(entry.resources.map(({ uri, digest, size }) => ({ uri, digest, size })).sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0)));
}

function validateRegistration(value: SkillRegistration): void {
  const keys = ["created_by", "created_at", "updated_by", "updated_at"];
  const login = (s: unknown) => typeof s === "string" && /^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(s);
  const timestamp = (s: unknown) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (!value || typeof value !== "object" || Object.keys(value).length !== 4 || keys.some(key => !Object.hasOwn(value, key)) || !login(value.created_by) || !login(value.updated_by) || !timestamp(value.created_at) || !timestamp(value.updated_at) || value.updated_at < value.created_at) throw new ReleaseError("Invalid skill registration metadata");
}

export function parseInventory(text: string, identity: ReleaseIdentity): Snapshot {
  const inventory = JSON.parse(text) as ReleaseInventory;
  if (inventory?.schema_version !== 1 || inventory.commit !== identity.commit || typeof inventory.release !== "string" || !inventory.release || inventory.release !== identity.release || !Array.isArray(inventory.skills) || !Array.isArray(inventory.files) || !inventory.aliases || typeof inventory.aliases !== "object" || Array.isArray(inventory.aliases)) throw new ReleaseError("Release inventory identity or structure is invalid");
  const paths = new Set<string>();
  const files = new Map<string, ReleaseFile>();
  for (const file of inventory.files) {
    assertDigest(file);
    releaseKey(identity.commit, file.path);
    if (paths.has(file.path) || ["inventory.json", "complete.json"].includes(file.path)) throw new ReleaseError("Duplicate or reserved inventory path");
    paths.add(file.path);
    if (file.uri !== undefined) {
      canonicalUri(file.uri);
      if (files.has(file.uri)) throw new ReleaseError("Duplicate resource URI in inventory");
      files.set(file.uri, file);
    }
  }
  const skills = new Set<string>();
  const referenced = new Set<string>();
  for (const entry of inventory.skills) {
    canonicalUri(entry.uri);
    if (!entry.uri.endsWith("/SKILL.md") || skills.has(entry.uri) || typeof entry.frontmatter?.name !== "string" || entry.frontmatter.name !== decodeURIComponent(entry.uri.split("/").at(-2)!) || typeof entry.frontmatter.description !== "string" || !entry.frontmatter.description || !Array.isArray(entry.resources) || entry.resources.length > 512) throw new ReleaseError("Invalid skill manifest");
    skills.add(entry.uri);
    if (entry.registration !== undefined) {
      validateRegistration(entry.registration);
    }
    const root = entry.uri.slice(0, -8);
    const resources = new Set<string>();
    let size = 0;
    for (const resource of entry.resources) {
      canonicalUri(resource.uri);
      assertDigest(resource);
      const file = files.get(resource.uri);
      if (!resource.uri.startsWith(root) || resources.has(resource.uri) || !file || file.digest !== resource.digest || file.size !== resource.size) throw new ReleaseError("Skill manifest differs from release inventory");
      resources.add(resource.uri);
      referenced.add(resource.uri);
      size += resource.size;
    }
    if (!resources.has(entry.uri) || size > 16 * 1024 * 1024) throw new ReleaseError("Incomplete or oversized skill manifest");
  }
  if (referenced.size !== files.size) throw new ReleaseError("Inventory exposes a resource outside all skill manifests");
  for (const [from, to] of Object.entries(inventory.aliases)) {
    canonicalUri(from); canonicalUri(to);
    if (!from.endsWith("/SKILL.md") || !to.endsWith("/SKILL.md") || skills.has(from)) throw new ReleaseError("Invalid or shadowing skill alias");
    resolveAlias(inventory, from);
  }
  if (inventory.packs !== undefined) {
    if (!Array.isArray(inventory.packs) || inventory.packs.length > 256) throw new ReleaseError("Invalid pack inventory");
    const names = new Set<string>();
    for (const pack of inventory.packs) {
      const definition = validatePack(pack.definition, skills);
      assertDigest(pack);
      const file = inventory.files.find(f => f.path === `packs/${definition.name}.json`);
      if (pack.uri !== packUri(definition.name) || names.has(pack.uri) || !file || file.uri !== undefined || file.digest !== pack.digest || file.size !== pack.size) throw new ReleaseError("Pack differs from release inventory");
      names.add(pack.uri);
      if (pack.registration !== undefined) validateRegistration(pack.registration);
    }
    if (inventory.files.filter(f => f.path.startsWith("packs/")).length !== inventory.packs.length) throw new ReleaseError("Unindexed pack file");
  } else if (inventory.files.some(f => f.path.startsWith("packs/"))) throw new ReleaseError("Pack files require a pack index");
  return { identity, inventory, files };
}

export function resolveAlias(inventory: ReleaseInventory, uri: string): string {
  canonicalUri(uri);
  let target = uri;
  const visited = new Set<string>();
  while (Object.hasOwn(inventory.aliases, target)) {
    if (visited.has(target) || visited.size >= 8) throw new ReleaseError("Cyclic or excessive skill aliases");
    visited.add(target);
    target = inventory.aliases[target];
  }
  if (!inventory.skills.some(entry => entry.uri === target)) throw new ReleaseError("Unknown skill URI", 404);
  return target;
}

export async function readSnapshot(bucket: R2Bucket, pin?: unknown): Promise<Snapshot> {
  let identity: ReleaseIdentity;
  if (pin === undefined) {
    const current = await readCurrent(bucket);
    if (!current) throw new ReleaseError("No release is currently published", 503);
    identity = current.value;
  } else {
    assertCommit(pin);
    const complete = await bucket.get(releaseKey(pin, "complete.json"));
    if (!complete) throw new ReleaseError("Unknown or incomplete pinned release", 404);
    identity = await complete.json<ReleaseIdentity>();
    if (identity?.commit !== pin) throw new ReleaseError("Pinned release identity differs from its key");
  }
  return readInventory(bucket, identity);
}

export async function readInventory(bucket: R2Bucket, identity: ReleaseIdentity): Promise<Snapshot> {
  assertCommit(identity.commit);
  if (!/^sha256:[a-f0-9]{64}$/.test(identity.inventory_digest)) throw new ReleaseError("Invalid inventory digest");
  const object = await bucket.get(releaseKey(identity.commit, "inventory.json"));
  if (!object || object.size > 8 * 1024 * 1024) throw new ReleaseError("Missing or oversized release inventory");
  const bytes = await object.arrayBuffer();
  if (await sha256(bytes) !== identity.inventory_digest) throw new ReleaseError("Release inventory failed digest verification");
  return parseInventory(new TextDecoder("utf-8", { fatal: true }).decode(bytes), identity);
}

const MIME: Record<string, string> = { md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json", yaml: "text/yaml", yml: "text/yaml", sh: "text/x-shellscript", bash: "text/x-shellscript", py: "text/x-python", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", css: "text/css", html: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
export function mimeType(uri: string): string {
  const extension = uri.split(".").at(-1)!.toLowerCase();
  return Object.hasOwn(MIME, extension) ? MIME[extension] : "application/octet-stream";
}

export async function readResource(bucket: R2Bucket, snapshot: Snapshot, uri: string): Promise<Record<string, unknown>> {
  canonicalUri(uri);
  const file = snapshot.files.get(uri);
  if (!file) throw new ReleaseError("Unknown resource URI in this release", 404);
  const bytes = await readVerifiedObject(bucket, releaseKey(snapshot.identity.commit, file.path), file);
  const mime = mimeType(uri);
  if (mime.startsWith("text/") || ["application/json", "image/svg+xml"].includes(mime)) return { uri, mimeType: mime, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let offset = 0; offset < view.length; offset += 8192) binary += String.fromCharCode(...view.subarray(offset, offset + 8192));
  return { uri, mimeType: mime, blob: btoa(binary) };
}

export function readDirectory(snapshot: Snapshot, uri: string): Array<{ uri: string; name: string; mimeType: string }> {
  canonicalUri(uri);
  if (snapshot.files.has(uri)) throw new ReleaseError("Resource is a file, not a directory", 400);
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const file of snapshot.files.keys()) if (file.startsWith(`${uri}/`)) {
    const suffix = file.slice(uri.length + 1);
    const part = suffix.split("/")[0];
    const child = `${uri}/${part}`;
    children.set(child, { uri: child, name: decodeURIComponent(part), mimeType: suffix.includes("/") ? "inode/directory" : mimeType(child) });
  }
  if (!children.size) throw new ReleaseError("Unknown directory URI in this release", 404);
  return [...children.values()].sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
}
