import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));

test("agent prompt treats failing assertions as behavior evidence before test edits", () => {
  const instructions = readFileSync(instructionsPath, "utf8");

  assert.match(instructions, /Treat failing tests, assertions, snapshots, and API-contract fixtures as\s+evidence/u);
  assert.match(instructions, /Do not\s+change the expected value merely because the current implementation returns\s+the received value/u);
  assert.match(instructions, /If that proof is missing or ambiguous, fix the\s+production source instead/u);
  assert.match(instructions, /If checks fail after your source edit because a\s+test or type checker no longer accepts the shape your edit introduced/u);
  assert.match(instructions, /Do not edit tests to accommodate a type or\s+behavior change caused by your own patch/u);
});

test("agent prompt constrains publish_fix to a single canonical summary field", () => {
  const instructions = readFileSync(instructionsPath, "utf8");

  assert.match(instructions, /Call `publish_fix` only after the relevant checks pass/u);
  assert.match(instructions, /\{ "summary": "<concise verified change summary>" \}/u);
  assert.match(instructions, /Do not include\s+`message`, `body`, file lists, status fields, or duplicate summary aliases/u);
});
