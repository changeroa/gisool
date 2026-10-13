import { watch, type FSWatcher } from "node:fs";

export const WATCH_DEBOUNCE_MS = 500;
const WATCH_FALLBACK_MS = 2000;

/**
 * Watches each root recursively and calls onChange once per quiet period of debounceMs.
 * Roots that do not exist (or cannot be watched) are skipped; the next refresh still reports them unreadable.
 */
export function watchRoots(roots: { id: string; path: string }[], onChange: () => void, opts: { debounceMs?: number } = {}): { close(): void } {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
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
    try {
      const watcher = watch(root.path, { recursive: true, persistent: false }, schedule);
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // missing or unwatchable root
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
