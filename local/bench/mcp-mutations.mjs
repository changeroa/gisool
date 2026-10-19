// Each mutation changes one compiled behavior only in memory. Source and dist stay untouched.
// Run after npm run build. A mutant counts only if its selected test fails an assertion,
// not if loading, syntax, timing or the test process fails.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mutations = [
  ["required version", "mcp/protocol.js", '[VERSION_KEY]: z.string(),', '[VERSION_KEY]: z.string().default("2026-07-28"),', "mcp-protocol", "each request requires"],
  ["required capabilities", "mcp/protocol.js", '}).passthrough(),\n    [CLIENT_INFO_KEY]', '}).passthrough().default({}),\n    [CLIENT_INFO_KEY]', "mcp-protocol", "each request requires"],
  ["version rejection", "mcp/protocol.js", "if (requested !== PROTOCOL_VERSION)", "if (false)", "mcp-protocol", "unsupported version"],
  ["header validation", "mcp/http.js", "checkHeaders(message, (name) => req.header(name));", "", "mcp-protocol", "HTTP headers are mandatory"],
  ["Base64 header decoding", "mcp/protocol.js", 'return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);', "return value;", "mcp-protocol", "HTTP headers are mandatory"],
  ["BOM header preservation", "mcp/protocol.js", "ignoreBOM: true", "ignoreBOM: false", "mcp-protocol", "encoded names preserve"],
  ["discovery capability shape", "mcp/dispatch.js", "capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } },", "capabilities: {},", "mcp", "modern discovery"],
  ["only search tool", "mcp/dispatch.js", '[SEARCH_TOOL], { cursor,', '[SEARCH_TOOL, { ...SEARCH_TOOL, name: "obsolete_reader" }], { cursor,', "mcp", "modern discovery"],
  ["legacy result shape", "mcp/legacy.js", "if (!isObject(_meta))\n        return rest;", "return result;", "mcp-protocol", "legacy initialize opens"],
  ["legacy session attribution", "mcp/http.js", "sessionId ? sessions.get(sessionId) : undefined", "undefined", "mcp-protocol", "legacy initialize opens"],
  ["legacy version negotiation", "mcp/legacy.js", "? requested : LEGACY_VERSIONS[0]", "? LEGACY_VERSIONS[0] : requested", "mcp-protocol", "legacy initialize opens"],
  ["modern era precedence", "mcp/legacy.js", "if (VERSION_KEY in meta || CLIENT_CAPABILITIES_KEY in meta)", "if (false)", "mcp-protocol", "unsupported version"],
  ["stdio legacy translation", "mcp/stdio-proxy.js", "toLegacyResult(modern.result)", "modern.result", "mcp-stdio", "stdio modern flow"],
  ["complete resultType", "mcp/dispatch.js", 'resultType: "complete", ...result', '...result', "mcp", "all cacheable results"],
  ["cache hints", "mcp/protocol.js", 'ttlMs: 60_000, cacheScope: "private"', 'ttlMs: -1, cacheScope: "public"', "mcp", "all cacheable results"],
  ["unknown skill code", "mcp/skills-extension.js", 'new RpcError(-32602, `Not a skill', 'new RpcError(-32002, `Not a skill', "mcp-protocol", "unknown methods"],
  ["unknown resource code", "mcp/skills-extension.js", '? -32602 : -32603;', '? -32002 : -32603;', "mcp-protocol", "unknown methods"],
  ["internal resource error", "mcp/skills-extension.js", '? -32602 : -32603;', '? -32602 : -32602;', "mcp", "changed resource bytes"],
  ["cursor progression", "mcp/pagination.js", "start = at + 1;", "start = 0;", "mcp", "skills and resources paginate"],
  ["invalid cursor rejection", "mcp/pagination.js", "if (at === -1)", "if (false)", "mcp", "skills and resources paginate"],
  ["verbatim frontmatter", "mcp/skills-extension.js", "frontmatter: entry.frontmatter,", "frontmatter: { name: entry.name, description: entry.description },", "mcp", "skills entries preserve"],
  ["resource metadata", "mcp/skills-extension.js", "name: skill?.name ??", 'name: undefined ??', "mcp", "resources expose SKILL"],
  ["lossless binary reads", "mcp/skills-extension.js", 'Buffer.from(file.text, "utf8").equals(bytes)', "true", "mcp", "resources expose SKILL"],
  ["load observations", "mcp/skills-extension.js", "ingest(loadEvent(", "void (loadEvent(", "mcp", "modern search and resource"],
  ["supporting file observations", "mcp/skills-extension.js", "ingest(readFileEvent(", "void (readFileEvent(", "mcp", "modern search and resource"],
  ["per-request identity", "mcp/dispatch.js", "const clientInfo = params._meta[CLIENT_INFO_KEY];", "const clientInfo = undefined;", "mcp", "client and vendor metadata"],
  ["trace correlation", "mcp/skills-extension.js", "const trace = ctx.meta?.[TRACE_KEY];", "const trace = undefined;", "mcp", "modern search and resource"],
  ["distinct observation IDs", "mcp/skills-extension.js", "const loadId = randomUUID();", 'const loadId = "shared";', "mcp", "resource reads need no prior"],
  ["observation not activation", "ingest/mcp-recorder.js", "observationOnly: true", "observationOnly: false", "mcp", "modern search and resource"],
  ["dotfile completeness", "catalog/scanner.js", "const relative = prefix ?", 'if (entry.name.startsWith(".")) continue;\n            const relative = prefix ?', "catalog-conformance", "complete manifests"],
  ["dependency completeness", "catalog/scanner.js", "const relative = prefix ?", 'if (entry.name === "node_modules") continue;\n            const relative = prefix ?', "catalog-conformance", "complete manifests"],
  ["nested completeness", "catalog/scanner.js", "await walk(path.join(dir, entry.name), relative);", 'if (entry.name !== "inner") await walk(path.join(dir, entry.name), relative);', "catalog-conformance", "complete manifests"],
  ["flat nested publication", "catalog/scanner.js", "if (info.isFile())\n                    output.push(relative);", "if (info.isFile() && !prefix)\n                    output.push(relative);", "catalog-conformance", "complete manifests"],
  ["name validation", "catalog/fields.js", "name !== name.toLowerCase()", "false", "catalog-conformance", "Agent Skills names"],
  ["description validation", "catalog/fields.js", "[...description].length > 1024", "[...description].length > 2048", "catalog-conformance", "frontmatter constraints"],
  ["reserved metadata isolation", "catalog/fields.js", 'invocation: frontmatter["disable-model-invocation"]', 'invocation: frontmatter.metadata?.["io.modelcontextprotocol/allowed-tools"] ? "explicit" : frontmatter["disable-model-invocation"]', "catalog-conformance", "frontmatter constraints"],
  ["resource count limit", "catalog/scanner.js", "MAX_SKILL_RESOURCE_COUNT = 512;", "MAX_SKILL_RESOURCE_COUNT = 513;", "catalog-conformance", "512 resources"],
  ["total byte limit", "catalog/scanner.js", "MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;", "MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024 + 1;", "catalog-conformance", "16 MiB raw"],
  ["canonical URI rules", "catalog/uri.js", "if (skillUri(rootId, ...segments.slice(1)) !== uri)", "if (false)", "catalog-conformance", "URI parsing"],
  ["addressable skill prefixes", "catalog/scanner.js", "if (!parseSkillUri(uri))", "if (false)", "catalog-conformance", "non-JSON frontmatter"],
  ["UTF-8 entry integrity", "catalog/scanner.js", 'new TextDecoder("utf-8", { fatal: true }).decode(bytes)', 'bytes.toString("utf8")', "catalog-conformance", "invalid UTF-8"],
  ["JSON frontmatter integrity", "catalog/scanner.js", "z.record(z.string(), z.json()).parse(frontmatter)", "JSON.parse(JSON.stringify(frontmatter))", "catalog-conformance", "non-JSON frontmatter"],
  ["nonregular completeness", "catalog/scanner.js", 'throw new CatalogError("non_regular_file", `Cannot include ${relative} in a complete manifest`);', "continue;", "catalog", "symlinks reject"],
  ["rate limiting", "mcp/tools.js", "++calls > 120", "++calls > 1200", "mcp", "search calls are rate"],
  ["stdio metadata forwarding", "mcp/stdio-proxy.js", "body: JSON.stringify(request),", 'body: JSON.stringify({ ...request, params: { ...request.params, _meta: undefined } }),', "mcp-stdio", "stdio modern flow"],
  ["HTTP method rejection", "mcp/http.js", '.status(405).end()', '.status(200).end()', "mcp-protocol", "modern requests never fall"],
  ["request body limits", "mcp/http.js", 'limit: "1mb"', 'limit: "4mb"', "mcp-protocol", "malformed JSON body"],
  ["valid JSON invalid request", "mcp/http.js", "strict: false", "strict: true", "mcp-protocol", "unknown methods"],
  ["notification framing", "mcp/http.js", "res.status(202).end();", 'res.status(200).json({});', "mcp-protocol", "malformed JSON body"],
];

const selected = process.argv[2] ? mutations.filter(([name]) => name.includes(process.argv[2])) : mutations;
if (!selected.length) throw new Error("No mutation matched");
let killed = 0;
for (const [name, file, from, to, testFile, pattern] of selected) {
  const target = new URL(`../dist/${file}`, import.meta.url).href;
  const loader = `
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== ${JSON.stringify(target)}) return loaded;
      const source = String(loaded.source);
      const from = ${JSON.stringify(from)};
      if (!source.includes(from)) throw new Error("MUTATION_TARGET_MISSING");
      process.stderr.write("MUTATION_APPLIED\\n");
      return { ...loaded, source: source.replaceAll(from, ${JSON.stringify(to)}) };
    } });`;
  const hook = "data:text/javascript;base64," + Buffer.from(loader).toString("base64");
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=10000", `--test-name-pattern=${pattern}`, `test/${testFile}.test.mjs`], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk; });
  child.stderr.on("data", (chunk) => { text += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0 && /MUTATION_APPLIED/.test(text) && /ERR_ASSERTION/.test(text) && !/SyntaxError|MUTATION_TARGET_MISSING|testTimeoutFailure/.test(text)) {
    killed++;
    console.log(`KILLED ${name}: ${testFile} / ${pattern}`);
  } else {
    console.error(`FAILED mutation check ${name} (exit ${code})\n${text}`);
    process.exitCode = 1;
  }
}
console.log(`MUTATIONS ${killed}/${selected.length} killed by assertions`);
