import { RpcError } from "./protocol.js";

export const PAGE_SIZE = 50;

/** A stable keyset cursor, bound to the method. No per-connection cursor state. */
export function paginate<T>(method: string, entries: readonly T[], opts: { cursor?: string; key: (item: T) => string }) {
  const sorted = [...entries].sort((a, b) => opts.key(a) < opts.key(b) ? -1 : opts.key(a) > opts.key(b) ? 1 : 0);
  const token = (item: T) => Buffer.from(JSON.stringify([method, opts.key(item)])).toString("base64url");
  let start = 0;
  if (opts.cursor !== undefined) {
    const at = sorted.findIndex((item) => token(item) === opts.cursor);
    if (at === -1) throw new RpcError(-32602, `Invalid or expired cursor for ${method}; restart listing`);
    start = at + 1;
  }
  const page = sorted.slice(start, start + PAGE_SIZE);
  const last = page.at(-1);
  return { page, ...(last !== undefined && start + page.length < sorted.length ? { nextCursor: token(last) } : {}) };
}
