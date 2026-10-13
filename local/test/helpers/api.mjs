import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { distImport, makeSandbox, writeFixtureSkill } from "../_helpers.mjs";

const { startServer } = await distImport("server.js");

export function fixtureText(name) {
  return readFileSync(new URL(`../fixtures/ingest/${name}`, import.meta.url), "utf8");
}

/** Starts the real composition root on an ephemeral port inside a sandbox HOME. */
export async function startTestServer(overrides = {}) {
  const sandbox = makeSandbox();
  const gisoolHome = sandbox.env.GISOOL_HOME;
  const skills = join(sandbox.home, "skills");
  writeFixtureSkill(skills, "pr-review", { description: "Review pull request code changes" });
  const config = { port: 0, captureLevel: "full", retentionDays: null, roots: [{ id: "agents", path: skills }], runtimes: {}, ...overrides };
  const server = await startServer(config, { gisoolHome, handleSignals: false });
  const token = readFileSync(join(gisoolHome, "token"), "utf8").trim();
  return {
    ...server, token, gisoolHome, home: sandbox.home, env: sandbox.env,
    async stop() {
      await server.close();
      sandbox.cleanup();
    },
  };
}

/** Raw HTTP request with full header control (fetch cannot override Host). */
export function http(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
export const jsonHeaders = (token) => ({ ...bearer(token), "Content-Type": "application/json" });
