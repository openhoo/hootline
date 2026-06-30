import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGlobInput } from "../agent/tools/glob.ts";
import { normalizeGrepInput } from "../agent/tools/grep.ts";
import { normalizeReadFileInput } from "../agent/tools/read_file.ts";

test("read_file wrapper normalizes aliases and corrects small repo path typos", async () => {
  const sandbox = new FakePathSandbox(["repo/src/app.ts"]);

  const input = await normalizeReadFileInput({ path: "src/ap.ts", limit: 20 }, sandbox);

  assert.equal(input.filePath, "/workspace/repo/src/app.ts");
  assert.equal(input.limit, 20);
});

test("grep wrapper normalizes pattern aliases and file paths", async () => {
  const sandbox = new FakePathSandbox(["repo/src/app.ts"]);

  const input = await normalizeGrepInput({ query: "value", filePath: "src/ap.ts" }, sandbox);

  assert.equal(input.pattern, "value");
  assert.equal(input.path, "/workspace/repo/src/app.ts");
});

test("glob wrapper normalizes pattern and directory aliases", () => {
  const input = normalizeGlobInput({ glob: "**/*.ts", directory: "repo/src" });

  assert.equal(input.pattern, "**/*.ts");
  assert.equal(input.path, "/workspace/repo/src");
});

test("glob wrapper preserves the staged repo root as a search directory", () => {
  const input = normalizeGlobInput({ glob: "**/*.ts", directory: "/workspace/repo/" });

  assert.equal(input.pattern, "**/*.ts");
  assert.equal(input.path, "/workspace/repo");
});

class FakePathSandbox {
  constructor(private readonly files: readonly string[]) {}

  async run(input: { command: string }) {
    if (input.command === "find repo -type f -not -path 'repo/.git/*' -print0") {
      return { exitCode: 0, stdout: `${this.files.join("\0")}\0`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readTextFile(input: { path: string }) {
    return this.files.includes(input.path) ? "content\n" : null;
  }
}
