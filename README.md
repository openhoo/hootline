# Hootline

Hootline is an Eve agent that repairs failing GitHub Actions and GitLab CI
pipelines. It accepts signed provider webhooks, loads repository policy, gathers
redacted failure context, starts a bounded Eve repair session, and publishes only
policy-allowed fixes that pass the configured checks.

At runtime, trusted Hootline code handles provider credentials, webhook
verification, repository archive download, failure-log collection, delivery
dedupe, attempt limits, publishing, reruns, and auto-merge follow-up. The model
works inside Eve's sandbox after calling `stage_repository_snapshot`, edits
`/workspace/repo`, runs `run_repo_checks`, and finishes with `publish_fix`,
`rerun_pipeline`, or `post_provider_comment`.

## Current Capabilities

- Providers:
  - GitHub `workflow_run` and `check_suite` completion webhooks.
  - GitLab pipeline webhooks.
- Publish modes:
  - `pr_mr`: create or update a fixer branch and PR/MR. This is the default.
  - `push_branch`: create or update the fixer branch only.
  - `auto_merge`: create or update a PR/MR and record it for deterministic merge
    after a successful follow-up pipeline webhook.
- Guardrails:
  - Repository opt-in through a default-branch `.hootline.yaml`.
  - Branch allowlist before a repair starts.
  - File allowlist before publishing.
  - Maximum attempts per provider/repo/SHA/pipeline key.
  - Repository archive and changed-file payload size caps.
  - Verification commands run in `/workspace/repo` before publishing.
  - Sandbox network defaults to deny-all unless policy lists allowed hosts.
  - Secrets and secret-looking text are redacted from logs and tool-visible
    command output.

## Local Setup

Install dependencies:

```sh
npm install
```

Create a local service environment file:

```sh
cp .env.example .env.local
```

Commit a Hootline policy file to every repository Hootline should repair:

```sh
cp config/hootline.example.yaml /path/to/repo/.hootline.yaml
```

Start the local Eve daemon:

```sh
npm run dev -- --host 127.0.0.1 --port 3000
```

Expose that daemon with your tunnel of choice and configure provider webhooks:

- GitHub: `POST /eve/v1/ci/github`
- GitLab: `POST /eve/v1/ci/gitlab`

## Environment

Core settings:

- `HOOTLINE_STATE_PATH`: durable JSON state file for delivery dedupe, attempts,
  verification results, publish records, rerun records, and pending auto-merge
  records. Defaults to `var/hootline-state.json`.
- `HOOTLINE_REPO_CONFIG_PATH`: repo-local policy path. Defaults to
  `.hootline.yaml`.
- `HOOTLINE_LOG_LEVEL`: Hootline log level,
  `trace|debug|info|warn|error|fatal|silent`. Defaults to `info`.
- `EVE_LOG_LEVEL`: Eve framework log level.

Model settings:

- `HOOTLINE_MODEL_PROVIDER`: one of `anthropic`, `openai`,
  `openai-compatible`, or `gateway`. Defaults to `anthropic`.
- `HOOTLINE_MODEL`: model id. Defaults depend on provider:
  `claude-sonnet-4-6`, `gpt-5.1`, `gpt-oss-120b`, or
  `anthropic/claude-sonnet-4.6`.
- `HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS`: optional for direct providers,
  required for `openai-compatible`. Must be between `4096` and `2000000`.
- `HOOTLINE_MODEL_API_KEY`: provider-specific override credential.
- `HOOTLINE_MODEL_BASE_URL`: optional for direct Anthropic/OpenAI,
  required for `openai-compatible`.
- `HOOTLINE_MODEL_PROVIDER_NAME`: metadata label for `openai-compatible`.
- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`: direct Anthropic credential.
- `OPENAI_API_KEY`: direct OpenAI credential.
- `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`: explicit gateway mode credential.

GitHub settings:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

GitLab settings:

- `GITLAB_BASE_URL`: defaults to `https://gitlab.com`.
- `GITLAB_TOKEN`: API token used to read archives/logs, push branches, create or
  update MRs, retry pipelines, merge MRs, and post comments.
- `GITLAB_SIGNING_TOKEN`: GitLab Standard Webhook signing token. Preferred.
- `GITLAB_SECRET_TOKEN`: optional legacy `X-Gitlab-Token` fallback. This is only
  accepted for repositories whose policy sets
  `allowGitlabSecretTokenFallback: true`.

## Model Provider Examples

Direct Anthropic:

```sh
HOOTLINE_MODEL_PROVIDER=anthropic
HOOTLINE_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=...
```

Direct OpenAI:

```sh
HOOTLINE_MODEL_PROVIDER=openai
HOOTLINE_MODEL=gpt-5.1
OPENAI_API_KEY=...
```

Local or hosted OpenAI-compatible endpoint:

```sh
HOOTLINE_MODEL_PROVIDER=openai-compatible
HOOTLINE_MODEL=local-coder
HOOTLINE_MODEL_BASE_URL=http://127.0.0.1:11434/v1
HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS=131072
HOOTLINE_MODEL_API_KEY=...
```

Explicit AI Gateway:

```sh
HOOTLINE_MODEL_PROVIDER=gateway
HOOTLINE_MODEL=anthropic/claude-sonnet-4.6
AI_GATEWAY_API_KEY=...
```

## Policy Configuration

Hootline reads `version: 1` YAML from the target repository's default-branch
`.hootline.yaml`. `config/hootline.example.yaml` is the canonical starting
point. Missing `.hootline.yaml` means the repository is not configured for
repairs.

Repository policy fields:

- `mode`: `pr_mr`, `push_branch`, or `auto_merge`.
- `allowedBranches`: event refs that may start repairs.
- `allowedFileGlobs`: changed paths that `publish_fix` may publish.
- `verificationCommands`: commands run inside `/workspace/repo` by
  `run_repo_checks` and again by `publish_fix`.
- `sandboxNetworkAllow`: host allowlist for verification command network access.
  Empty means deny-all.
- `fixBranchPrefix`: prefix for generated fixer branches.
- `maxAttemptsPerSha`: repair attempts allowed per provider/repo/SHA/pipeline.
- `maxSnapshotBytes`: archive and changed payload size limit.
- `allowGitlabSecretTokenFallback`: opt-in for legacy GitLab secret-token
  webhook verification.
- `autoMerge.requireSuccessfulPipeline`: when true, auto-merge waits for a later
  successful pipeline webhook on the fixer branch.
- `autoMerge.deleteSourceBranch`: delete the fixer branch after merge when the
  provider supports it.

Policy globs are intentionally small: `*` and `?` match within a path segment,
while `**` may cross directories.

Run a single Hootline process per state file. State writes are serialized inside
one Node process; separate processes sharing the same state path can still race.

## GitHub App Setup

Hootline uses a GitHub App for webhook verification, archive reads, job log
reads, failed-job reruns, branch writes, PR creation or updates, comments, and
merges. The manifest helper requires an authenticated `gh` CLI.

For local testing, start Hootline, expose it through a public HTTPS tunnel, then
run:

```sh
npm run github-app:setup -- --webhook-base-url https://your-tunnel.example
```

Use `--webhook-url` instead when you already have the full GitHub webhook URL:

```sh
npm run github-app:setup -- --webhook-url https://example.com/eve/v1/ci/github
```

For organization-owned apps:

```sh
npm run github-app:setup -- --owner-type org --owner your-org --webhook-base-url https://your-tunnel.example
```

Open the printed local URL and submit the manifest form. After GitHub redirects
back, the helper exchanges the manifest code and writes credentials under
`var/github-app/` with mode `0600`.

Source the generated environment before starting Hootline:

```sh
set -a
source .env.local
source var/github-app/<app-slug>.env
set +a
npm run dev -- --host 127.0.0.1 --port 3000
```

Verify the app can see a repository:

```sh
source var/github-app/<app-slug>.env
npm run github-app:check-installation -- owner/repo
```

The generated app requests repository permissions for Actions write, Checks
read, Contents write, Issues write, Metadata read, and Pull requests write. It
subscribes to `workflow_run` and `check_suite` events.

## Pipeline Fixture Reset

The `wakemeup0/hootline-pipeline-fixture` repo is reset through a destructive,
repeatable workflow so every end-to-end test starts from the same repairable
state. The default baseline is commit
`51548227536681dc832fc83ee091c57c17fff864`, also pushed as tag
`hootline-fixture-baseline-v1`; it contains passing tests plus `.hootline.yaml`.

Preview the reset plan:

```sh
npm run fixture:reset -- --dry-run
```

Run the reset:

```sh
npm run fixture:reset -- --yes
```

The workflow:

- closes all open PRs in the fixture repo;
- deletes remote `hootline/fix/*` branches;
- force-pushes fixture `main` back to the baseline commit;
- verifies the baseline with `npm test`;
- changes `src/checkout.js` back to the known discount bug;
- verifies the bug fails the fixture tests;
- commits and pushes the fresh failing `main` commit.

Defaults can be overridden with `HOOTLINE_FIXTURE_REPO`,
`HOOTLINE_FIXTURE_PATH`, `HOOTLINE_FIXTURE_BASELINE_REF`,
`HOOTLINE_FIXTURE_MAIN_BRANCH`, and `HOOTLINE_FIXTURE_FIX_BRANCH_PREFIX`.

### Cloudflare Quick Tunnel

For local GitHub webhook testing without a permanent public host:

```sh
cloudflared tunnel --url http://127.0.0.1:3000
npm run github-app:setup -- --webhook-base-url https://your-tunnel.trycloudflare.com
```

Quick tunnel URLs are temporary. If the tunnel restarts, update the GitHub App
webhook URL or rerun the manifest helper with the new URL.

## GitLab Setup

Configure a GitLab pipeline webhook to call:

```text
https://your-hootline-host/eve/v1/ci/gitlab
```

Prefer GitLab Standard Webhooks and set `GITLAB_SIGNING_TOKEN` to the signing
secret. For older integrations that only send `X-Gitlab-Token`, set
`GITLAB_SECRET_TOKEN` and opt in per repository:

```yaml
version: 1
allowGitlabSecretTokenFallback: true
```

The fallback is weaker than Standard Webhook signatures and is rejected unless
policy explicitly enables it.

## Repair Loop

Each repair session starts with four seeded context blocks:

- `Hootline state`: the active `attemptKey`.
- `Normalized pipeline event`: provider, repo, ref, SHA, pipeline/run ids,
  actor, and PR/MR metadata when available.
- `Repository policy`: publish mode, allowed branches, allowed file globs,
  verification commands, sandbox network allowlist, attempt limits, and
  auto-merge settings.
- `Initial failure context collected by trusted runtime code`: redacted failed
  job metadata and log snippets, or a collection error.

The model should call `get_failure_context` only when the seeded logs are
missing, stale, truncated across the root-cause area, or contradicted by later
tool output. Repository files are not preloaded; the model must call
`stage_repository_snapshot` before reading, editing, checking, or publishing.

Normal repair flow:

1. Inspect the seeded event, policy, and failure context.
2. Stage `/workspace/repo`.
3. Find the earliest causal CI error.
4. Make the smallest allowed fix.
5. Run `run_repo_checks`.
6. Call `publish_fix` after relevant checks pass.
7. Request a transient rerun or post a provider comment when no safe code fix is
   appropriate.

`publish_fix` reruns the configured verification commands and rejects changed
paths outside `allowedFileGlobs` before calling provider APIs.

## Logging

Hootline emits structured logs through `agent/lib/logger.ts`. Every dynamic
value is passed through `agent/lib/redact.ts` before it is written.

- Pretty, colorized output is used when stdout is a TTY.
- JSON lines are used in production/CI.
- Every line includes `ns`, such as `channels.ci`, `tools.publish_fix`,
  `providers.github`, `providers.gitlab`, `lib.config`, or `lib.sandbox`.
- Repair lifecycle logs carry `attemptKey`, `provider`, `repoSlug`, and
  `deliveryKey` once available.
- Logged errors include stable redacted `errorId` values for support
  correlation.

Tests run with `HOOTLINE_LOG_LEVEL=silent` so application logs do not
interleave with test output.

## Architecture Notes

Eve owns Hootline's durable model loop: sessions, step replay, compaction,
streaming events, tool execution, sandboxed shell/file access, and the
app-runtime/sandbox boundary. Hootline intentionally does not wrap the agent in
AI SDK `ToolLoopAgent`, `streamText` loops, or `ai-sdk-tools` state/artifact
stores.

The current `ai` dependency remains because Eve declares it as a peer dependency
and Hootline uses AI SDK provider packages to resolve the configured language
model.

The default `web_fetch` and `web_search` tools are disabled. Provider APIs are
available only through narrow Hootline tools bound to the active `attemptKey`
and repository policy.

## Development Commands

```sh
npm run dev -- --host 127.0.0.1 --port 3000
npm run info
npm run build
npm run typecheck
npm test
npm run check:model-matrix
npm run fixture:reset -- --dry-run
npm run github-app:setup -- --help
```

Full local verification:

```sh
npm run typecheck
npm test
npm run check:model-matrix
ANTHROPIC_API_KEY=test HOOTLINE_MODEL_PROVIDER=anthropic HOOTLINE_MODEL=claude-sonnet-4-6 npm run info
ANTHROPIC_API_KEY=test HOOTLINE_MODEL_PROVIDER=anthropic HOOTLINE_MODEL=claude-sonnet-4-6 npm run build
```
