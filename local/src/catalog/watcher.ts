import { watch, type FSWatcher } from "node:fs";

export const WATCH_DEBOUNCE_MS = 500;

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
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
