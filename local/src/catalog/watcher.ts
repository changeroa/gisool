import { existsSync, watch, type FSWatcher } from "node:fs";

export const WATCH_DEBOUNCE_MS = 500;
const WATCH_FALLBACK_MS = 2000;

/**
 * Watches each root recursively and calls onChange once per quiet period of debounceMs.
 * Roots that do not exist (or cannot be watched) are skipped with one log line; the next refresh still reports them unreadable.
 * A watcher that errors later (EMFILE, EACCES) is logged once and closed; the periodic refresh keeps detecting changes.
 */
export function watchRoots(
  roots: { id: string; path: string }[],
  onChange: () => void,
  opts: { debounceMs?: number; log: (msg: string) => void; watchFn?: typeof watch },
): { close(): void } {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
  const watchFn = opts.watchFn ?? watch;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };
  for (const root of roots) {
    if (!existsSync(root.path)) {
      opts.log(`catalog watcher cannot watch root ${root.id} (${root.path}): path does not exist`);
      continue;
    }
    try {
      const watcher = watchFn(root.path, { recursive: true, persistent: false }, schedule);
      let failed = false;
      watcher.on("error", (error) => {
        if (failed) return;
        failed = true;
        opts.log(`catalog watcher for root ${root.id} (${root.path}) failed: ${error.message}`);
        watcher.close();
      });
      watchers.push(watcher);
    } catch (error) {
      opts.log(`catalog watcher cannot watch root ${root.id} (${root.path}): ${(error as Error).message}`);
    }
  }
  // fs.watch can drop events under load; a periodic refresh (no-op when nothing changed) bounds detection latency.
  let poll: NodeJS.Timeout | undefined;
  if (watchers.length > 0) {
    poll = setInterval(schedule, WATCH_FALLBACK_MS);
    poll.unref();
  }
  return {
    close() {
      closed = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
