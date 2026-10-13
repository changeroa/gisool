import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const out = new URL("dist/dashboard/", root);
await mkdir(new URL("assets/", out), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("dashboard/main.tsx", root))],
  outdir: fileURLToPath(new URL("assets/", out)),
  entryNames: "app",
  chunkNames: "chunk-[hash]",
  splitting: true,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  logLevel: "warning",
});
await copyFile(new URL("dashboard/index.html", root), new URL("index.html", out));
await copyFile(new URL("dashboard/styles.css", root), new URL("assets/styles.css", out));
// tsc does not copy non-TS assets; the store reads schema.sql next to db.js.
await mkdir(new URL("dist/store/", root), { recursive: true });
await copyFile(new URL("src/store/schema.sql", root), new URL("dist/store/schema.sql", root));
console.log(`Built dashboard: ${fileURLToPath(out)}`);
