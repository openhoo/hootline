import assert from "node:assert/strict";
import test from "node:test";

import { matchesAnyPattern, matchesPattern } from "../agent/lib/glob.ts";

test("matches policy globs without crossing single-star path segments", () => {
  assert.equal(matchesPattern("src/index.ts", "src/*.ts"), true);
  assert.equal(matchesPattern("src/lib/index.ts", "src/*.ts"), false);
  assert.equal(matchesPattern("src/lib/index.ts", "src/**"), true);
  assert.equal(matchesPattern(".github/workflows/ci.yml", ".github/workflows/**"), true);
  assert.equal(matchesAnyPattern("package.json", ["src/**", "package.json"]), true);
  assert.equal(matchesAnyPattern("README.md", ["src/**", "package.json"]), false);
});

test("double-star slash globs match root-level files", () => {
  assert.equal(matchesPattern("package.json", "**/*"), true);
  assert.equal(matchesPattern("src/index.ts", "**/*"), true);
  assert.equal(matchesPattern("index.ts", "**/*.ts"), true);
  assert.equal(matchesPattern("src/lib/index.ts", "**/*.ts"), true);
  assert.equal(matchesPattern("src/index.ts", "src/**/*.ts"), true);
  assert.equal(matchesPattern("src/lib/index.ts", "src/**/*.ts"), true);
});
