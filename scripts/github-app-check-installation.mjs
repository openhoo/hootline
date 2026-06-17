#!/usr/bin/env node
import { createSign } from "node:crypto";

const repo = process.argv[2];

if (process.argv.includes("--help") || process.argv.includes("-h") || repo === undefined) {
  console.log(`Usage:
  source var/github-app/<app-slug>.env
  npm run github-app:check-installation -- owner/repo
`);
  process.exit(repo === undefined ? 1 : 0);
}

const appId = readRequiredEnv("GITHUB_APP_ID");
const privateKey = readRequiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
const jwt = createGitHubJwt(appId, privateKey);
const response = await fetch(`https://api.github.com/repos/${repo}/installation`, {
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "x-github-api-version": "2022-11-28",
  },
});

const body = await readJson(response);
if (!response.ok) {
  throw new Error(`GitHub App is not installed on ${repo}: HTTP ${response.status} ${readMessage(body)}`);
}
if (typeof body !== "object" || body === null || typeof body.id !== "number") {
  throw new Error("GitHub repository installation response did not include an installation id.");
}

console.log(`GitHub App ${appId} is installed on ${repo} as installation ${body.id}.`);

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

function createGitHubJwt(issuer, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: issuer })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

async function readJson(response) {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function readMessage(body) {
  if (typeof body === "object" && body !== null && typeof body.message === "string") return body.message;
  return "Unknown error";
}
