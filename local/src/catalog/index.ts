import { readFile } from "node:fs/promises";
import type { Catalog, CatalogDelta, GisoolConfig, SkillEntry, SkillUri } from "../types.js";
import { applyFamilies } from "./fields.js";
import { assertRegularSkillPath, CatalogError, scanRoot, sha256 } from "./scanner.js";
import { parseSkillUri, skillUri } from "./uri.js";
import { watchRoots } from "./watcher.js";

export { CatalogError } from "./scanner.js";
export { parseSkillUri, skillUri } from "./uri.js";

export type CatalogOptions = Pick<GisoolConfig, "roots"> & {
  /** Start a recursive fs.watch on every root that refreshes after a debounce (default false). */
  watch?: boolean;
  watchDebounceMs?: number;
  log?: (msg: string) => void;
};

export type ManagedCatalog = Catalog & { close(): void };

type Report = ReturnType<Catalog["report"]>;

function deltaIsEmpty(d: CatalogDelta): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/** Indexes the configured skill roots in place. Nothing is scanned until refresh(); nothing is ever written. */
export function createCatalog(config: CatalogOptions): ManagedCatalog {
  const roots = config.roots.map((r) => ({ id: r.id, path: r.path }));
  const log = config.log ?? console.error;
  let entries = new Map<SkillUri, SkillEntry>();
  let resourceIndex = new Map<SkillUri, { entry: SkillEntry; digest: string; size: number }>();
  let families: Report["families"] = [];
  let rootStatus: Report["roots"] = roots.map((r) => ({ id: r.id, path: r.path, readable: false, count: 0 }));
  const listeners = new Set<(d: CatalogDelta) => void>();
  let chain: Promise<unknown> = Promise.resolve();

  async function scan(): Promise<CatalogDelta> {
    const next: SkillEntry[] = [];
    const explicit = new Map<string, { id: string; stage?: string } | undefined>();
    const status: Report["roots"] = [];
    const seen = new Set<SkillUri>();
    for (const root of roots) {
      const { readable, skills } = await scanRoot(root, log);
      let count = 0;
      for (const { entry, explicitGroup } of skills) {
        if (seen.has(entry.uri)) continue;
        seen.add(entry.uri);
        next.push(entry);
        explicit.set(entry.uri, explicitGroup);
        count += 1;
      }
      status.push({ id: root.id, path: root.path, readable, count });
    }
    next.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    const nextFamilies = applyFamilies(next, explicit);

    const delta: CatalogDelta = { added: [], changed: [], removed: [] };
    const nextMap = new Map(next.map((e) => [e.uri, e]));
    for (const entry of next) {
      const prev = entries.get(entry.uri);
      if (!prev) delta.added.push(entry);
      else if (prev.manifestDigest !== entry.manifestDigest || JSON.stringify(prev.group) !== JSON.stringify(entry.group)) delta.changed.push(entry);
    }
    for (const uri of entries.keys()) if (!nextMap.has(uri)) delta.removed.push(uri);

    const nextResources = new Map<SkillUri, { entry: SkillEntry; digest: string; size: number }>();
    for (const entry of next) for (const r of entry.resources) nextResources.set(r.uri, { entry, digest: r.digest, size: r.size });
    entries = nextMap;
    resourceIndex = nextResources;
    families = nextFamilies;
    rootStatus = status;

    if (!deltaIsEmpty(delta)) {
      for (const cb of listeners) {
        try {
          cb(delta);
        } catch (error) {
          log(`catalog onDelta listener failed: ${(error as Error).message}`);
        }
      }
    }
    return delta;
  }

  function refresh(): Promise<CatalogDelta> {
    const run = chain.then(scan, scan);
    chain = run.catch(() => undefined);
    return run;
  }

  const watcher = config.watch
    ? watchRoots(roots, () => {
        refresh().catch((error) => log(`catalog refresh failed: ${(error as Error).message}`));
      }, { debounceMs: config.watchDebounceMs, log })
    : undefined;

  return {
    list: () => [...entries.values()],
    get: (uri) => entries.get(uri),
    async readResource(uri) {
      const parsed = parseSkillUri(uri);
      if (!parsed) throw new CatalogError("invalid_uri", "not a valid skill://local URI");
      const root = roots.find((r) => r.id === parsed.rootId);
      if (!root) throw new CatalogError("unknown_root", `unknown skill root: ${parsed.rootId}`);
      const canonical = skillUri(parsed.rootId, ...parsed.segments);
      const filePath = await assertRegularSkillPath(root.path, parsed.segments);
      const known = resourceIndex.get(canonical);
      if (!known) throw new CatalogError("unknown_resource", "resource is not in any skill manifest");
      const bytes = await readFile(filePath);
      const digest = sha256(bytes);
      if (digest !== known.digest) throw new CatalogError("digest_mismatch", "resource changed since the last catalog refresh");
      return { text: bytes.toString("utf8"), digest, size: bytes.byteLength };
    },
    refresh,
    onDelta(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    report() {
      const byName = new Map<string, { roots: Set<string>; uris: SkillUri[] }>();
      for (const entry of entries.values()) {
        if (!byName.has(entry.name)) byName.set(entry.name, { roots: new Set(), uris: [] });
        const slot = byName.get(entry.name)!;
        slot.roots.add(entry.rootId);
        slot.uris.push(entry.uri);
      }
      const duplicates = [...byName.entries()]
        .filter(([, v]) => v.roots.size > 1)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, v]) => ({ name, uris: v.uris.sort() }));
      return {
        duplicates,
        families: families.map((f) => ({ id: f.id, uris: [...f.uris] })),
        roots: rootStatus.map((r) => ({ ...r })),
      };
    },
    close() {
      watcher?.close();
      listeners.clear();
    },
  };
}
