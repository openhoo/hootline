import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeToolInput,
  readAliasedBoolean,
  readAliasedTextCandidates,
  readOptionalAliasedString,
  readRequiredAliasedString,
  readRequiredAliasedInteger,
  readRequiredAliasedText,
  summarySchema,
} from "../agent/lib/tool-input.ts";

test("normalizes common tool-call envelopes and JSON string arguments", () => {
  assert.deepEqual(normalizeToolInput({ input: { summary: "fixed" } }), { summary: "fixed" });
  assert.deepEqual(normalizeToolInput({ arguments: '{"path":"src/app.ts"}' }), { path: "src/app.ts" });
  assert.deepEqual(normalizeToolInput('{"args":{"reason":"retry runner"}}'), { reason: "retry runner" });
});

test("reads aliased strings and rejects conflicting aliases", () => {
  const input = normalizeToolInput({ message: "publish summary" });
  assert.equal(readRequiredAliasedString(input, "summary", ["message", "body"]), "publish summary");
  assert.equal(readOptionalAliasedString({ path: " src/app.ts " }, "filePath", ["path"]), "src/app.ts");

  assert.throws(
    () => readRequiredAliasedString({ summary: "one", message: "two" }, "summary", ["message"]),
    /Conflicting values for input summary/,
  );
});

test("publish summary schema exposes only the canonical summary key", () => {
  assert.deepEqual(Object.keys(summarySchema.properties), ["summary"]);
  assert.equal(summarySchema.additionalProperties, true);
});

test("preserves exact aliased text for source edits", () => {
  const input = normalizeToolInput({
    oldText: "  const value = 1;\n",
    newText: "",
  });
  assert.equal(readRequiredAliasedText(input, "expected", ["oldText"]), "  const value = 1;\n");
  assert.equal(readRequiredAliasedText(input, "replacement", ["newText"], { allowEmpty: true }), "");
});

test("collects aliased text candidates without applying generic conflict rules", () => {
  const input = normalizeToolInput({
    replacement: "first",
    new_text: "second",
    replace: "",
  });

  assert.deepEqual(readAliasedTextCandidates(input, "replacement", ["new_text", "replace"], { allowEmpty: true }), [
    { key: "replacement", value: "first" },
    { key: "new_text", value: "second" },
    { key: "replace", value: "" },
  ]);
});

test("coerces simple boolean aliases", () => {
  assert.equal(readAliasedBoolean({ confirmed_successful_pipeline: "true" }, "confirmedSuccessfulPipeline", [
    "confirmed_successful_pipeline",
  ]), true);
  assert.equal(readAliasedBoolean({ confirmed: 0 }, "confirmedSuccessfulPipeline", ["confirmed"], true), false);
});

test("coerces integer aliases", () => {
  assert.equal(readRequiredAliasedInteger({ start: "2" }, "startLine", ["start"]), 2);
  assert.throws(
    () => readRequiredAliasedInteger({ start: "2.5" }, "startLine", ["start"]),
    /Missing required integer input: startLine/,
  );
});
