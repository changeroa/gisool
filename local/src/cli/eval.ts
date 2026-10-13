import { readFileSync } from "node:fs";
import { createCatalog } from "../catalog/index.js";
import { createSearchIndex } from "../search/index.js";
import { openDb } from "../store/db.js";
import type { CliDeps } from "../types.js";

type Case = { query: string; expectedUri?: string };

export type EvalReport = { cases: number; judged: number; hitAt1: number; hitAt3: number; mrr: number; abstainRate: number;
  misses: { query: string; expectedUri: string; rank: number | null }[] };

export async function runEval(opts: { cases?: string; json?: boolean }, deps: CliDeps): Promise<number> {
  const store = deps.openStore();
  const catalog = createCatalog({ roots: deps.config.roots, log: () => {} });
  const db = openDb(":memory:");
  try {
    let cases: Case[] = store.evalCases();
    if (opts.cases) {
      const extra: unknown = JSON.parse(readFileSync(opts.cases, "utf8"));
      if (!Array.isArray(extra)) throw new Error("cases file must be a JSON array of { query, expectedUri? }");
      cases = [...cases, ...(extra as Case[])];
    }
    const index = createSearchIndex(db);
    await catalog.refresh();
    index.rebuild(catalog.list());

    let judged = 0, h1 = 0, h3 = 0, rr = 0, abstained = 0;
    const misses: EvalReport["misses"] = [];
    for (const c of cases) {
      const out = index.search(c.query, { mode: "discovery", limit: 10 });
      if (out.abstained) abstained++;
      if (!c.expectedUri) continue;
      judged++;
      const pos = out.candidates.findIndex((x) => x.uri === c.expectedUri);
      if (pos === 0) h1++;
      if (pos >= 0 && pos < 3) h3++;
      if (pos >= 0) rr += 1 / (pos + 1);
      if (pos !== 0) misses.push({ query: c.query, expectedUri: c.expectedUri, rank: pos >= 0 ? pos + 1 : null });
    }
    const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
    const report: EvalReport = { cases: cases.length, judged, hitAt1: ratio(h1, judged), hitAt3: ratio(h3, judged), mrr: ratio(rr, judged),
      abstainRate: ratio(abstained, cases.length), misses };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`cases: ${report.cases} (with expectation: ${judged})`);
      console.log(`hit@1: ${report.hitAt1.toFixed(3)}`);
      console.log(`hit@3: ${report.hitAt3.toFixed(3)}`);
      console.log(`MRR: ${report.mrr.toFixed(3)}`);
      console.log(`abstain rate: ${report.abstainRate.toFixed(3)}`);
      for (const m of misses) console.log(`miss: "${m.query}" expected ${m.expectedUri} rank ${m.rank ?? "none"}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    catalog.close();
    db.close();
    store.close();
  }
}
