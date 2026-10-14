export type FsHealth = { ok: boolean; lastOkAt?: number; stalledMs?: number };

export type FsWatchdog = { health(): FsHealth; stop(): void };

// A long-running daemon was seen with every async fs request pending forever while the event loop stayed alive:
// /healthz kept answering but the dashboard, assets, and resource reads hung. The watchdog probes the filesystem on a
// timer; a probe still pending after timeoutMs means fs is stalled, and onStall runs once so the service manager
// can restart the process.
export function createFsWatchdog(opts: {
  probe: () => Promise<unknown>;
  intervalMs: number;
  timeoutMs: number;
  onStall: (stalledMs: number) => void;
  now?: () => number;
}): FsWatchdog {
  const now = opts.now ?? Date.now;
  let inFlightSince: number | undefined;
  let lastOkAt: number | undefined;
  let stalled = false;

  const tick = () => {
    if (inFlightSince !== undefined) {
      const waited = now() - inFlightSince;
      if (!stalled && waited >= opts.timeoutMs) {
        stalled = true;
        opts.onStall(waited);
      }
      return;
    }
    const started = now();
    inFlightSince = started;
    opts.probe().then(
      () => { lastOkAt = now(); },
      () => { lastOkAt = now(); }, // a rejected probe still proves fs requests complete
    ).finally(() => { if (inFlightSince === started) inFlightSince = undefined; });
  };

  const timer = setInterval(tick, opts.intervalMs);
  timer.unref();
  tick();

  return {
    health() {
      const pendingMs = inFlightSince === undefined ? 0 : now() - inFlightSince;
      const ok = !stalled && pendingMs < opts.timeoutMs;
      return { ok, ...(lastOkAt !== undefined ? { lastOkAt } : {}), ...(ok ? {} : { stalledMs: pendingMs }) };
    },
    stop() { clearInterval(timer); },
  };
}
