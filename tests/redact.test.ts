import { test } from "node:test";
import assert from "node:assert/strict";

import { redact } from "../agent/lib/redact.ts";

test("redacts fine-grained GitHub PATs", () => {
  const secret =
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
  const out = redact(`token is ${secret} here`);
  assert.ok(!out.includes(secret));
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts GitLab token families (glcbt/glrt/glptt/glsoat/gldeploy)", () => {
  for (const prefix of ["glcbt", "glrt", "glptt", "glsoat", "gldeploy"]) {
    const secret = `${prefix}-aB3_dE6-fG9hI0jK1lM2nO3pQ4`;
    const out = redact(`value ${secret} end`);
    assert.ok(!out.includes(secret), `${prefix} token leaked`);
    assert.ok(out.includes("[REDACTED]"));
  }
});

test("redacts Cerebras API keys", () => {
  const secret = "csk-abc123DEF456ghi789";
  const out = redact(`cerebras key ${secret}`);
  assert.ok(!out.includes(secret));
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts AWS access key ids (AKIA and ASIA)", () => {
  const akia = "AKIAIOSFODNN7EXAMPLE";
  const asia = "ASIAIOSFODNN7EXAMPLE";
  const out = redact(`keys ${akia} and ${asia}`);
  assert.ok(!out.includes(akia));
  assert.ok(!out.includes(asia));
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs)", () => {
  for (const prefix of ["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"]) {
    const secret = `${prefix}-2345678901-2345678901-AbCdEfGhIjKlMnOpQrStUvWx`;
    const out = redact(`slack ${secret} token`);
    assert.ok(!out.includes(secret), `${prefix} token leaked`);
    assert.ok(out.includes("[REDACTED]"));
  }
});

test("redacts PEM private key blocks", () => {
  const key = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAuVelExampleKeyMaterialThatShouldNeverLeak0123456789",
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/0123456789==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redact(`here is a key:\n${key}\nafter`);
  assert.ok(!out.includes("ExampleKeyMaterialThatShouldNeverLeak"));
  assert.ok(out.includes("[REDACTED]"));
});

test("authorization Bearer keeps prefix but drops the token", () => {
  const out = redact("authorization: Bearer abc123secretvalue");
  assert.ok(out.includes("authorization: Bearer"));
  assert.ok(!out.includes("abc123secretvalue"));
  assert.ok(out.includes("[REDACTED]"));
});

test("password assignment drops the value", () => {
  const out = redact("password=hunter2");
  assert.ok(!out.includes("hunter2"));
  assert.ok(out.includes("[REDACTED]"));
});

test("x-gitlab-token header is redacted", () => {
  const out = redact("x-gitlab-token: glpat-aB3dE6fG9hI0jK1lM2nO");
  assert.ok(!out.includes("glpat-aB3dE6fG9hI0jK1lM2nO"));
  assert.ok(out.includes("[REDACTED]"));
});

test("x-hub-signature-256 header keeps prefix but drops the digest", () => {
  const digest = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const out = redact(`x-hub-signature-256: sha256=${digest}`);
  assert.ok(!out.includes(digest));
  assert.ok(out.includes("x-hub-signature-256: sha256=[REDACTED]"));
});

test("raw gho_/ghu_ token mid-text is redacted", () => {
  const secret = "gho_16ABcdEFghIJklMNopQRstUVwxYZ0123456789";
  const out = redact(`prefix ${secret} suffix`);
  assert.ok(!out.includes(secret));
  assert.ok(out.includes("[REDACTED]"));
});

test("strings over maxLength are truncated with a byte-count suffix", () => {
  const input = "a".repeat(100);
  const out = redact(input, 40);
  assert.ok(out.startsWith("a".repeat(40)));
  assert.ok(out.endsWith("[truncated 60 bytes]"));
});

test("clean text with no secrets passes through unchanged", () => {
  const input = "Build failed: expected 2 arguments but got 3 in main.ts line 42.";
  assert.equal(redact(input), input);
});
