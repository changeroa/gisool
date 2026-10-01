import { parse } from "yaml";
import { BodyTooLargeError, jsonResponse, readBody, validBearer } from "./http.ts";
import { assertCommit, putImmutableObject, readCurrent, readVerifiedObject, releaseKey, ReleaseError, sha256, switchCurrent, verifyInventory } from "./r2-objects.ts";
import type { CurrentRelease, ReleaseIdentity } from "./r2-objects.ts";
import { manifestDigest, parseInventory, readInventory, readSnapshot } from "./release-reader.ts";

export type PublishRequest = ReleaseIdentity & { expected_etag: string | null; sequence: number };
export type PublisherEnv = { SKILLS_BUCKET: R2Bucket; GISUL_PUBLISH_TOKEN?: string };

function equalMetadata(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalMetadata(left[key], right[key]));
}

export async function publishRelease(bucket: R2Bucket, input: PublishRequest, operation: "promote" | "rollback" | "verify"): Promise<CurrentRelease | ReleaseIdentity> {
  const identity: ReleaseIdentity = { commit: input.commit, release: input.release, inventory_digest: input.inventory_digest };
  // Rollback cannot turn an unverified upload into a completed release.
  const snapshot = operation === "rollback" ? await readSnapshot(bucket, identity.commit) : await readInventory(bucket, identity);
  if (snapshot.identity.release !== identity.release || snapshot.identity.inventory_digest !== identity.inventory_digest) throw new ReleaseError("Rollback identity differs from the retained release");
  const releaseFile = snapshot.inventory.files.find(file => file.path === "release.json");
  if (!releaseFile) throw new ReleaseError("The validated builder release.json is required");
  const record = JSON.parse(new TextDecoder().decode(await readVerifiedObject(bucket, releaseKey(identity.commit, releaseFile.path), releaseFile))) as { commit: string; release: string; skills: Array<{ uri: string; manifest_digest: string }> };
  if (record?.commit !== identity.commit || record.release !== identity.release || !Array.isArray(record.skills) || record.skills.length !== snapshot.inventory.skills.length) throw new ReleaseError("Builder release metadata differs from inventory");
  const expected = new Map(record.skills.map(skill => [skill.uri, skill.manifest_digest]));
  if (expected.size !== record.skills.length) throw new ReleaseError("Duplicate skill in builder release metadata");
  for (const skill of snapshot.inventory.skills) if (expected.get(skill.uri) !== await manifestDigest(skill)) throw new ReleaseError("Builder manifest digest differs from served skill");
  const inventoryKey = releaseKey(identity.commit, "inventory.json");
  const inventoryObject = await bucket.head(inventoryKey);
  if (!inventoryObject) throw new ReleaseError("Missing release inventory");
  const skillBodies = new Map(snapshot.inventory.skills.map(skill => [releaseKey(identity.commit, snapshot.files.get(skill.uri)!.path), skill.frontmatter]));
  const packBodies = new Map((snapshot.inventory.packs ?? []).map(pack => [releaseKey(identity.commit, `packs/${pack.definition.name}.json`), pack.definition]));
  await verifyInventory(bucket, identity.commit, [
    ...snapshot.inventory.files.map(({ path, digest, size }) => ({ key: releaseKey(identity.commit, path), digest, size })),
    { key: inventoryKey, digest: identity.inventory_digest, size: inventoryObject.size },
  ], ["complete.json"], (file, bytes) => {
    const pack = packBodies.get(file.key);
    if (pack && !equalMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pack)) throw new ReleaseError("Pack definition differs from inventory");
    const frontmatter = skillBodies.get(file.key);
    if (!frontmatter) return;
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match || !equalMetadata(parse(match[1]), frontmatter)) throw new ReleaseError("SKILL.md frontmatter differs from the inventory");
  });
  if (operation !== "rollback") await putImmutableObject(bucket, identity.commit, "complete.json", new TextEncoder().encode(JSON.stringify(identity)).buffer);
  if (operation === "verify") return identity;
  return switchCurrent(bucket, identity, input.expected_etag, input.sequence, operation);
}

export async function publisherFetch(request: Request, env: PublisherEnv): Promise<Response> {
  if (!env.GISUL_PUBLISH_TOKEN) return jsonResponse(request, { error: "Release publishing is not configured" }, 503);
  if (!await validBearer(request, env.GISUL_PUBLISH_TOKEN)) return jsonResponse(request, { error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
  const url = new URL(request.url);
  try {
    if (url.pathname === "/admin/current" && request.method === "GET") {
      const current = await readCurrent(env.SKILLS_BUCKET);
      return jsonResponse(request, { current: current?.value ?? null, etag: current?.etag ?? null });
    }
    const retained = /^\/admin\/releases\/([a-f0-9]{40})$/.exec(url.pathname);
    if (retained && request.method === "GET") {
      return jsonResponse(request, (await readSnapshot(env.SKILLS_BUCKET, retained[1])).identity);
    }
    const upload = /^\/admin\/releases\/([a-f0-9]{40})\/(.+)$/.exec(url.pathname);
    if (upload && request.method === "PUT") {
      const relative = decodeURIComponent(upload[2]);
      releaseKey(upload[1], relative);
      if (relative === "complete.json") throw new ReleaseError("Only verified releases can receive a completion marker", 400);
      const bytes = await readBody(request, 16 * 1024 * 1024);
      let inventoryBytes = bytes;
      if (relative !== "inventory.json") {
        const inventory = await env.SKILLS_BUCKET.get(releaseKey(upload[1], "inventory.json"));
        if (!inventory || inventory.size > 8 * 1024 * 1024) throw new ReleaseError("Upload inventory.json before its objects");
        inventoryBytes = await inventory.arrayBuffer();
      }
      if (inventoryBytes.byteLength > 8 * 1024 * 1024) throw new ReleaseError("Release inventory is too large", 413);
      const inventoryText = new TextDecoder("utf-8", { fatal: true }).decode(inventoryBytes);
      const snapshot = parseInventory(inventoryText, { commit: upload[1], release: JSON.parse(inventoryText).release, inventory_digest: await sha256(inventoryBytes) });
      if (relative !== "inventory.json") {
        const file = snapshot.inventory.files.find(file => file.path === relative);
        if (!file || file.size !== bytes.byteLength || file.digest !== await sha256(bytes)) throw new ReleaseError("Upload does not match the immutable inventory");
      }
      const result = await putImmutableObject(env.SKILLS_BUCKET, upload[1], relative, bytes);
      return jsonResponse(request, result, result.created ? 201 : 200);
    }
    if (["/admin/promote", "/admin/rollback", "/admin/verify"].includes(url.pathname) && request.method === "POST") {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request, 64 * 1024))) as PublishRequest;
      assertCommit(body?.commit);
      if (typeof body.release !== "string" || !body.release || typeof body.inventory_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.inventory_digest) || (body.expected_etag !== null && typeof body.expected_etag !== "string") || !Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new ReleaseError("Invalid publication request", 400);
      const operation = url.pathname.endsWith("rollback") ? "rollback" : url.pathname.endsWith("verify") ? "verify" : "promote";
      const result = await publishRelease(env.SKILLS_BUCKET, body, operation);
      return jsonResponse(request, result);
    }
    return jsonResponse(request, { error: "Not Found" }, 404);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return jsonResponse(request, { error: error.message }, 413);
    if (error instanceof ReleaseError) return jsonResponse(request, { error: error.message }, error.status);
    return jsonResponse(request, { error: "Release operation did not complete; re-read /admin/current before retrying" }, 500);
  }
}
