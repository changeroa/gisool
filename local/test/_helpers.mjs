import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

// Existing server tests must never discover or connect to the user's live herdr.
process.env.GISOOL_HERDR = "off";

export const PACKAGE_ROOT = new URL("../", import.meta.url);

/** Imports a compiled module from local/dist, e.g. distImport("store/db.js"). */
export function distImport(rel) {
  return import(new URL(`dist/${rel}`, PACKAGE_ROOT).href);
}

export function makeTempDir(prefix = "gisool-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const UNSET = [
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR",
  "GJC_CODING_AGENT_DIR", "GJC_CONFIG_DIR", "PI_CONFIG_DIR",
];

/** Env per the sandbox rule: fresh HOME, GISOOL_HOME inside it, GISOOL_NO_CLI=1, runtime config vars removed. */
export function sandboxEnv(home, base = process.env) {
  const env = { ...base };
  for (const key of UNSET) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("OPENCLAW_")) delete env[key];
  env.HOME = home;
  env.GISOOL_HOME = join(home, ".gisool");
  env.GISOOL_NO_CLI = "1";
  env.GISOOL_HERDR = "off";
  return env;
}

/** Creates a sandbox HOME and returns { home, env, cleanup }. */
export function makeSandbox() {
  const home = makeTempDir("gisool-home-");
  return { home, env: sandboxEnv(home), cleanup: () => removeDir(home) };
}

/**
 * Writes <root>/<dir>/SKILL.md with YAML frontmatter plus optional extra files.
 * frontmatter defaults to { name: dir, description }; files maps relative path -> contents.
 */
export function writeFixtureSkill(root, dir, { name = dir, description = `${dir} fixture skill`, frontmatter = {}, body = `# ${name}\n`, files = {} } = {}) {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  const head = stringify({ name, description, ...frontmatter }).trimEnd();
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\n${head}\n---\n${body}`);
  for (const [rel, contents] of Object.entries(files)) {
    const p = join(skillDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents);
  }
  return skillPath;
}
