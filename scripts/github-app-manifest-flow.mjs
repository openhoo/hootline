#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const DEFAULT_PORT = 8787;
const DEFAULT_APP_NAME = `hootline-pipeline-fixer-${new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .slice(0, 13)
  .toLowerCase()}`;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const webhookUrl = readWebhookUrl(options);
const port = readInteger(options.port, DEFAULT_PORT);
const host = options.host ?? "127.0.0.1";
const appName = options.name ?? DEFAULT_APP_NAME;
const owner = options.owner;
const ownerType = readOwnerType(options.ownerType);
const outputDir = resolve(options.outputDir ?? "var/github-app");
const callbackUrl = `http://${host}:${port}/callback`;
const state = crypto.randomUUID();
const manifest = buildManifest({ appName, callbackUrl, webhookUrl, repoUrl: options.repoUrl });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  if (url.pathname === "/") {
    sendHtml(res, renderRegistrationPage({ manifest, owner, ownerType, state }));
    return;
  }

  if (url.pathname === "/callback") {
    if (url.searchParams.get("state") !== state) {
      sendText(res, 400, "State mismatch. Restart the setup helper and try again.\n");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      sendText(res, 400, "Missing GitHub App manifest code in callback URL.\n");
      return;
    }
    try {
      const result = convertManifestCode(code);
      const written = writeAppCredentials({ outputDir, result });
      sendHtml(res, renderSuccessPage({ result, written }));
      console.log(`\nGitHub App created: ${result.html_url ?? result.name ?? result.slug ?? result.id}`);
      console.log(`Credentials written to: ${written.envPath}`);
      if (result.slug) {
        console.log(`Install it on the target repository: https://github.com/apps/${result.slug}/installations/new`);
      }
      console.log("Stop this helper with Ctrl-C after installing the app.\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendText(res, 500, `${message}\n`);
      console.error(message);
    }
    return;
  }

  sendText(res, 404, "Not found\n");
});

server.listen(port, host, () => {
  console.log(`GitHub App setup helper listening at http://${host}:${port}/`);
  console.log(`Webhook URL: ${webhookUrl}`);
  console.log("Open the local URL above and submit the manifest form.");
});

function buildManifest({ appName, callbackUrl, webhookUrl, repoUrl }) {
  return {
    name: appName,
    url: repoUrl ?? "https://github.com/openhoo/hootline",
    hook_attributes: {
      url: webhookUrl,
      active: true,
    },
    redirect_url: callbackUrl,
    public: false,
    default_permissions: {
      actions: "write",
      checks: "read",
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: ["workflow_run", "check_suite"],
  };
}

function convertManifestCode(code) {
  const output = execFileSync(
    "gh",
    ["api", "-X", "POST", `/app-manifests/${code}/conversions`],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function writeAppCredentials({ outputDir, result }) {
  if (typeof result.id !== "number") throw new Error("GitHub manifest conversion did not return an app id.");
  if (typeof result.pem !== "string") throw new Error("GitHub manifest conversion did not return a private key.");
  if (typeof result.webhook_secret !== "string") {
    throw new Error("GitHub manifest conversion did not return a webhook secret.");
  }

  mkdirSync(outputDir, { recursive: true });
  const basename = sanitizeFileName(result.slug ?? result.name ?? `github-app-${result.id}`);
  const jsonPath = resolve(outputDir, `${basename}.json`);
  const envPath = resolve(outputDir, `${basename}.env`);
  const env = [
    `export GITHUB_APP_ID=${shellQuote(String(result.id))}`,
    `export GITHUB_WEBHOOK_SECRET=${shellQuote(result.webhook_secret)}`,
    `export GITHUB_APP_PRIVATE_KEY=${shellQuote(result.pem)}`,
    "",
  ].join("\n");

  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(envPath, env, { mode: 0o600 });
  chmodSync(jsonPath, 0o600);
  chmodSync(envPath, 0o600);
  return { jsonPath, envPath };
}

function renderRegistrationPage({ manifest, owner, ownerType, state }) {
  const action =
    ownerType === "org"
      ? `https://github.com/organizations/${encodeURIComponent(requiredOwner(owner))}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const manifestText = JSON.stringify(manifest);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Register Hootline GitHub App</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 56rem; }
      textarea { width: 100%; height: 18rem; font-family: ui-monospace, monospace; }
      button { font: inherit; padding: 0.5rem 0.75rem; }
      code { background: #f6f8fa; padding: 0.125rem 0.25rem; }
    </style>
  </head>
  <body>
    <h1>Register Hootline GitHub App</h1>
    <p>This form submits a GitHub App manifest to GitHub. After approval, GitHub redirects back here and this helper writes credentials under <code>var/github-app/</code>.</p>
    <form action="${escapeHtml(action)}" method="post">
      <textarea name="manifest" spellcheck="false">${escapeHtml(manifestText)}</textarea>
      <p><button type="submit">Create GitHub App</button></p>
    </form>
  </body>
</html>`;
}

function renderSuccessPage({ result, written }) {
  const installUrl = result.slug ? `https://github.com/apps/${result.slug}/installations/new` : undefined;
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Hootline GitHub App Created</title></head>
  <body>
    <h1>GitHub App Created</h1>
    <p>Credentials were written to <code>${escapeHtml(written.envPath)}</code>.</p>
    ${installUrl ? `<p><a href="${escapeHtml(installUrl)}">Install the app on the target repository</a></p>` : ""}
    <p>Use <code>source ${escapeHtml(written.envPath)}</code> before starting Hootline.</p>
  </body>
</html>`;
}

function readWebhookUrl(options) {
  if (options.webhookUrl) return trimTrailingSlash(options.webhookUrl);
  if (options.webhookBaseUrl) return `${trimTrailingSlash(options.webhookBaseUrl)}/eve/v1/ci/github`;
  throw new Error("Missing --webhook-url or --webhook-base-url. Use a public tunnel URL for local dev.");
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = toCamelCase(arg.slice(2));
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run github-app:setup -- --webhook-base-url https://example.ngrok-free.app
  npm run github-app:setup -- --webhook-url https://example.com/eve/v1/ci/github

Options:
  --webhook-base-url <url>  Public Hootline base URL; appends /eve/v1/ci/github.
  --webhook-url <url>       Full GitHub webhook URL.
  --name <name>             GitHub App name. Defaults to a timestamped Hootline name.
  --port <port>             Local callback server port. Default: ${DEFAULT_PORT}.
  --owner-type <user|org>   Register under your user or an organization. Default: user.
  --owner <login>           Required with --owner-type org.
  --repo-url <url>          Public project URL shown on the GitHub App.
  --output-dir <path>       Credential output directory. Default: var/github-app.
`);
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function readInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function readOwnerType(value) {
  const ownerType = value ?? "user";
  if (ownerType !== "user" && ownerType !== "org") {
    throw new Error(`Invalid --owner-type: ${ownerType}. Expected user or org.`);
  }
  return ownerType;
}

function requiredOwner(owner) {
  if (!owner) throw new Error("--owner is required when --owner-type org is used.");
  return owner;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "github-app";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
