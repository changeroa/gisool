import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { distImport, makeSandbox, writeFixtureSkill } from "./_helpers.mjs";
import { capture, makeDeps } from "./helpers/cli-export-import.mjs";

const { runEval } = await distImport("cli/eval.js");
const U = (d) => `skill://local/t/${d}/SKILL.md`;

test("eval metrics on a 4-case set match hand-computed values", async () => {
  const sb = makeSandbox();
  try {
    const root = join(sb.home, "skills");
    writeFixtureSkill(root, "alpha", { description: "zebra quartz migration planner" });
    writeFixtureSkill(root, "beta", { description: "walrus topaz invoice exporter" });
    writeFixtureSkill(root, "gamma", { description: "walrus topaz zebra lantern" });
    const deps = makeDeps(sb.home, sb.env, { port: 1, captureLevel: "full", retentionDays: null, roots: [{ id: "t", path: root }], runtimes: {} });
    mkdirSync(deps.gisoolHome, { recursive: true });
    const s = deps.openStore();
    s.addEvalCase({ query: "zebra quartz migration", expectedUri: U("alpha") });   // rank 1
    s.addEvalCase({ query: "walrus topaz invoice", expectedUri: U("beta") });      // rank 1
    s.addEvalCase({ query: "walrus topaz invoice", expectedUri: U("gamma") });     // rank 2
    s.addEvalCase({ query: "qqqxzz", expectedUri: U("alpha") });                   // abstains, miss
    s.close();
    const file = join(sb.home, "cases.json");
    writeFileSync(file, "[]");
    const r = await capture(() => runEval({ cases: file, json: true }, deps));
    assert.equal(r.code, 0, r.out);
    const rep = JSON.parse(r.out);
    assert.equal(rep.cases, 4);
    assert.equal(rep.hitAt1, 0.5);
    assert.equal(rep.hitAt3, 0.75);
    assert.equal(rep.mrr, (1 + 1 + 0.5 + 0) / 4);
    assert.equal(rep.abstainRate, 0.25);
    assert.deepEqual(rep.misses.map((m) => [m.query, m.rank]), [["walrus topaz invoice", 2], ["qqqxzz", null]]);
    const text = await capture(() => runEval({}, deps));
    assert.match(text.out, /hit@1: 0\.500/);
    assert.match(text.out, /MRR: 0\.625/);
  } finally {
    sb.cleanup();
  }
});
