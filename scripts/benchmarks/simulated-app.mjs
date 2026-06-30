import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const APP_WORKSPACE_PATHS = [
  "agent",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "instrumentation.ts",
];

export function prepareBenchmarkAppWorkspace({ artifactDir, sourceRoot }) {
  const appRoot = resolve(artifactDir, "app");
  rmSync(appRoot, { recursive: true, force: true });
  mkdirSync(appRoot, { recursive: true });

  for (const relativePath of APP_WORKSPACE_PATHS) {
    const sourcePath = resolve(sourceRoot, relativePath);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = resolve(appRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { recursive: true });
  }

  const sourceNodeModules = resolve(sourceRoot, "node_modules");
  if (!existsSync(sourceNodeModules)) {
    throw new Error(`node_modules is required to build the simulated benchmark app: ${sourceNodeModules}`);
  }
  symlinkSync(sourceNodeModules, resolve(appRoot, "node_modules"), "dir");
  return appRoot;
}

export function loadBenchmarkEnvFiles(sourceRoot, baseEnv = process.env) {
  const env = { ...baseEnv };
  const baseKeys = new Set(Object.keys(baseEnv));
  for (const fileName of [".env", ".env.local"]) {
    const envPath = resolve(sourceRoot, fileName);
    if (!existsSync(envPath)) continue;
    const values = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (!baseKeys.has(key)) env[key] = value;
    }
  }
  return env;
}

export function parseDotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trimStart();

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseDotEnvValue(trimmed.slice(separator + 1));
  }
  return values;
}

function parseDotEnvValue(rawValue) {
  const value = rawValue.trimStart();
  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (quote === "'" || value[index - 1] !== "\\") return index;
  }
  return -1;
}
