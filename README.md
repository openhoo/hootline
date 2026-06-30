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

## Project Layout

See [docs/architecture.md](docs/architecture.md) for the module boundaries and
benchmark harness structure. In short: `agent/` is the Eve-authored runtime
surface, provider side effects stay in trusted runtime code, `agent/tools/` stay
thin and model-facing, and reusable benchmark logic lives under
`scripts/benchmarks/`.

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

## Container Image

Build the production image locally:

```sh
docker build -t ghcr.io/openhoo/hootline:local .
```

Eve compiles the selected model into the image at build time. Use build args
when the image should route to a non-default provider:

```sh
docker build \
  --build-arg HOOTLINE_MODEL_PROVIDER=openai-compatible \
  --build-arg HOOTLINE_MODEL=gemma-4-31b \
  --build-arg HOOTLINE_MODEL_BASE_URL=https://api.cerebras.ai/v1 \
  --build-arg HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS=65536 \
  --build-arg HOOTLINE_MODEL_PROVIDER_NAME=cerebras \
  -t ghcr.io/openhoo/hootline:local .
```

Run the image with runtime credentials and persistent service state:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v hootline-data:/data \
  -e HOOTLINE_MODEL_API_KEY \
  -e GITHUB_APP_ID \
  -e GITHUB_APP_PRIVATE_KEY \
  -e GITHUB_WEBHOOK_SECRET \
  ghcr.io/openhoo/hootline:local
```

When repairs need Eve's local Docker sandbox backend, make the host Docker
daemon available to the container:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v hootline-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --env-file .env.local \
  ghcr.io/openhoo/hootline:local
```

The image listens on `0.0.0.0:${PORT:-3000}`, persists Hootline state at
`/data/hootline-state.json` by default, and exposes `/eve/v1/health` for Docker
health checks. Do not pass real model or provider API keys as Docker build args;
provide them only as runtime environment variables.

## Release And GHCR Publishing

CI runs typecheck, tests, model matrix validation, an Eve production build, a
Docker build, and Conventional Commit linting through Hooversion. After CI
passes on `main`, the release workflow runs Hooversion to derive the next
semantic version from Conventional Commits, update `package.json`,
`package-lock.json`, and `CHANGELOG.md`, create a GitHub release, then publish a
multi-arch image to GitHub Container Registry.

The `package.json` is intentionally `private`; Hootline is released as source,
GitHub releases, and GHCR images, not as a public npm package.

Published image tags:

- `ghcr.io/openhoo/hootline:<version>`
- `ghcr.io/openhoo/hootline:<major>.<minor>`
- `ghcr.io/openhoo/hootline:sha-<commit>`
- `ghcr.io/openhoo/hootline:latest`

## Environment

Core settings:

- `HOST`: bind address used by Eve. Defaults to the runtime's framework default;
  the container sets `0.0.0.0`.
- `PORT`: HTTP port used by Eve. The container defaults to `3000`.
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
- `allowedBranches`: required event refs that may start repairs.
- `allowedFileGlobs`: required changed paths that `publish_fix` may publish.
- `verificationCommands`: required commands run inside `/workspace/repo` by
  `run_repo_checks` and again by `publish_fix`. At least one command is
  required so `publish_fix` cannot publish without a repository-defined check.
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
one Node process; separate processes or replicas sharing the same state path can
race delivery dedupe, repair-slot claims, and auto-merge claims. Use one
container/replica per state file unless the state backend is replaced with a
durable cross-process lock.

Model/provider API failures are retried inside the same repair slot before
Hootline falls back to provider redelivery. Configure this with:

- `HOOTLINE_PROVIDER_ERROR_RETRIES`: retryable provider-error sessions to start
  after the initial Eve session fails. Default `2`.
- `HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS`: exponential backoff base delay.
  Default `1000`.
- `HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS`: backoff cap. Default `15000`.

These retries do not increment repository `maxAttemptsPerSha`; that policy still
limits provider webhook repair attempts.

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

## Simulated Benchmark

`benchmark:sim` is the primary benchmark path for agent and harness changes. It
runs the full Eve repair loop against a simulated GitHub provider, so it does
not reset a real repository, call `gh`, wait on GitHub Actions, or require a
public webhook tunnel. The runner materializes a local benchmark repo from one
of the realistic project fixtures under `benchmarks/fixtures/projects/`,
injects the selected scenario, sends a signed synthetic `workflow_run` webhook
to Hootline, and records the simulated PR/check result under
`var/simulated-benchmarks/`.

Preview the selected scenarios without starting Hootline:

```sh
npm run benchmark:sim:dry-run
```

Dry runs are read-only: they validate fixture metadata and print rows without
creating benchmark artifacts or simulator state.

Run one deterministic smoke sample with Eve's mock model:

```sh
npm run benchmark:sim -- --mock-model --scenarios shipping-threshold-basis --samples 1
```

Run only one fixture project:

```sh
npm run benchmark:sim:dry-run -- --projects support-desk
```

Run the same simulated harness with the configured real model:

```sh
npm run benchmark:sim -- --scenarios all --samples 1
```

Run multiple simulated scenario samples concurrently:

```sh
npm run benchmark:sim -- --mock-model --scenarios all --samples 1 --concurrency 4
```

Use `--artifact-dir <path>` to write a non-dry-run's artifacts to a specific
directory. Fixture verification commands time out after 60000 ms by default;
override with `--fixture-command-timeout-ms <ms>` when a scenario needs a
different bound.

The benchmark projects are intentionally larger than the individual scenario
mutations. The default suite currently includes `commerce-platform` and
`support-desk`, each with its own `package.json`, `.hootline.yaml`, `src/`, and
`test/` tree. This makes the repair loop navigate realistic project directories
even when a scenario changes only one business rule. The fixtures include
cross-module workflows such as customer-aware checkout tax, warehouse
reservation, freight fulfillment, payment authorization, requester-profile
inference, queue routing, localized notifications, audit, and reporting.

The runner starts a built local Eve server automatically unless `--server-url`
is supplied. For auto-started servers it sets
`HOOTLINE_GITHUB_PROVIDER_BACKEND=simulated`,
`HOOTLINE_SIMULATOR_STATE_PATH`, `HOOTLINE_STATE_PATH`, and a synthetic
`GITHUB_WEBHOOK_SECRET` for the child process. When using `--server-url`, start
the server yourself with matching env values.

Rows include repair metadata and simulated PR/check details, including actual
changed files, expected-vs-actual repair file match, and simulated branch check
conclusion. Shared row/status/summary helpers live in
`scripts/benchmarks/common.mjs`.

The benchmark waits for Hootline to publish or terminate the repair attempt,
waits for simulated fixer PR checks when a PR is opened, and records attempt
count, tool sequence, failed tools, continuation count, token usage, terminal
action, PR URL, PR check result, scenario complexity, scenario tags, mutation
count, project id, verification commands, the expected repair file set, summary
breakdowns by project, complexity, tag, and mutation count, and non-green
improvement signals.

Scenario ids are listed by `npm run benchmark:sim -- --help`. The catalog favors
a bounded set of realistic regressions over broad scenario volume: most rows are
single-rule issues inside larger applications, while complex rows require
multi-file repairs across domain boundaries.

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

## Session Inspection

Eve stores local repair session streams under `.workflow-data`. When a repair
appears quiet, inspect the visible session transcript and tool events:

```sh
npm run session:inspect -- wrun_01KWBMAS9SGYY60502V4G11CYE
```

The report includes event counts, tool-call order, step finish reasons, the
final assistant-message excerpt, and whether Hootline state recorded a staged
repo, verification, publish, or rerun. Use `--message-chars` to change excerpt
length or `--json` for machine-readable output.

You can also read the live Eve stream while the dev server is running:

```text
GET /eve/v1/session/<session-id>/stream
```

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
npm run lint
npm run typecheck
npm test
npm run check:model-matrix
npm exec --yes @openhoo/hooversion@0.1.1 -- plan
docker build -t ghcr.io/openhoo/hootline:local .
npm run benchmark:sim:dry-run
npm run session:inspect -- <session-id>
npm run github-app:setup -- --help
```

Full local verification:

```sh
npm run lint
npm test
npm run check:model-matrix
ANTHROPIC_API_KEY=test HOOTLINE_MODEL_PROVIDER=anthropic HOOTLINE_MODEL=claude-sonnet-4-6 npm run info
ANTHROPIC_API_KEY=test HOOTLINE_MODEL_PROVIDER=anthropic HOOTLINE_MODEL=claude-sonnet-4-6 npm run build
```
