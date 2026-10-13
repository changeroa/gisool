import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";

const { applyCapture, MASK } = await distImport("ingest/redact.js");

const secrets = {
  openai: "sk-" + "a".repeat(24),
  github: "ghp_" + "B".repeat(36),
  aws: "AKIA" + "ABCDEFGHIJ123456",
  slack: "xoxb-1234-5678-abcdEFGH",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----",
  bearer: "Bearer " + "abc.DEF_ghi-" + "z".repeat(16),
};

for (const [name, secret] of Object.entries(secrets)) {
  test(`redacted masks ${name}`, () => {
    const out = applyCapture("redacted", `before ${secret} after`);
    assert.equal(out.text, `before ${MASK} after`);
  });
}

test("short look-alikes are not masked", () => {
  const text = "sk-short ghp_short AKIA123 Bearer abc";
  assert.equal(applyCapture("redacted", text).text, text);
});

test("full keeps text unchanged, including secrets", () => {
  const text = `key ${secrets.openai}`;
  assert.deepEqual(applyCapture("full", text), { text, textDigest: createHash("sha256").update(text).digest("hex"), textLength: text.length });
});

test("redacted truncates to 2048 chars after masking", () => {
  const text = secrets.github + " " + "x".repeat(5000);
  const out = applyCapture("redacted", text);
  assert.equal(out.text.length, 2048);
  assert.ok(out.text.startsWith(MASK));
  assert.equal(out.textLength, text.length);
});

test("metadata drops text and keeps sha256 digest and length", () => {
  const text = "프롬프트 secret";
  const out = applyCapture("metadata", text);
  assert.equal(out.text, undefined);
  assert.equal(out.textDigest, createHash("sha256").update(text, "utf8").digest("hex"));
  assert.equal(out.textLength, text.length);
});
