# Hootline

Hootline is an Eve agent that repairs failing GitHub Actions and GitLab CI pipelines.

The webhook route performs deterministic setup before the model runs: it verifies the provider signature, normalizes the pipeline event, loads repo policy, deduplicates the delivery, fetches failed job/log context, and seeds the Eve turn with that context. The model then stages the repository snapshot, edits `/workspace/repo`, runs policy checks, and calls `publish_fix`.

## Local Setup

1. Install dependencies:

```sh
npm install
```

2. Copy and edit the policy:

```sh
cp config/pipeline-fixer.example.yaml config/pipeline-fixer.yaml
```

3. Set environment:

```sh
cp .env.example .env.local
```

Core values:

- `PIPELINE_FIXER_CONFIG`
- `PIPELINE_FIXER_MODEL_PROVIDER`
- a model credential for the configured model provider

GitHub values:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

GitLab values:

- `GITLAB_TOKEN`
- `GITLAB_SIGNING_TOKEN`

### Configure the model provider

Hootline passes a resolved AI SDK language model into Eve. It does not require
Vercel AI Gateway for local development.

Supported model providers:

- `anthropic`: direct Anthropic provider. Defaults to
  `PIPELINE_FIXER_MODEL=claude-sonnet-4-6` and uses `ANTHROPIC_API_KEY` unless
  `PIPELINE_FIXER_MODEL_API_KEY` is set.
- `openai`: direct OpenAI provider. Defaults to `PIPELINE_FIXER_MODEL=gpt-5.1`
  and uses `OPENAI_API_KEY` unless `PIPELINE_FIXER_MODEL_API_KEY` is set.
- `openai-compatible`: any OpenAI-compatible endpoint. Requires
  `PIPELINE_FIXER_MODEL_BASE_URL` and
  `PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS`; `PIPELINE_FIXER_MODEL_API_KEY` is
  optional for unauthenticated local endpoints. Set
  `PIPELINE_FIXER_MODEL_PROVIDER_NAME` when you want provider-specific metadata
  labeled with a stable name.
- `gateway`: explicit Vercel AI Gateway mode. In this mode
  `PIPELINE_FIXER_MODEL` is passed through as a gateway model id such as
  `anthropic/claude-sonnet-4.6`, and the runtime needs `AI_GATEWAY_API_KEY` or
  `VERCEL_OIDC_TOKEN`.

Set `PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS` when Eve cannot infer the
model's context window from provider metadata, or when you want the compaction
threshold to be pinned for testing. Values must be between `4096` and
`2000000`.

Examples:

```sh
# Direct Anthropic
PIPELINE_FIXER_MODEL_PROVIDER=anthropic
PIPELINE_FIXER_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=...

# Direct OpenAI
PIPELINE_FIXER_MODEL_PROVIDER=openai
PIPELINE_FIXER_MODEL=gpt-5.1
OPENAI_API_KEY=...

# Local or hosted OpenAI-compatible endpoint
PIPELINE_FIXER_MODEL_PROVIDER=openai-compatible
PIPELINE_FIXER_MODEL=llama-3.3-70b-instruct
PIPELINE_FIXER_MODEL_BASE_URL=http://127.0.0.1:11434/v1
PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS=131072
PIPELINE_FIXER_MODEL_API_KEY=...
```

4. Start locally:

```sh
npm run dev -- --host 127.0.0.1 --port 3000
```

Expose the local daemon with your tunnel of choice and configure provider webhooks:

- GitHub: `POST /eve/v1/ci/github`
- GitLab: `POST /eve/v1/ci/gitlab`

### Test through Cloudflare

For local GitHub webhook testing without a permanent public host, run Hootline
on `127.0.0.1:3000` and start a Cloudflare quick tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:3000
```

Cloudflare prints a fresh `https://*.trycloudflare.com` URL. Keep that process
running, then pass the URL to the GitHub App helper:

```sh
npm run github-app:setup -- --webhook-base-url https://your-tunnel.trycloudflare.com
```

Quick tunnel URLs are temporary. If the tunnel restarts, update the GitHub App
webhook URL or rerun the manifest helper with the new URL.

### Create a GitHub App

Hootline uses a GitHub App for webhook verification, repository archive reads,
job log reads, reruns, branch writes, PR creation, and provider comments. For
local testing, start Hootline, expose it through a public HTTPS tunnel, then run
the manifest helper:

```sh
npm run github-app:setup -- --webhook-base-url https://your-tunnel.example
```

Open the printed local URL and submit the manifest form. After GitHub redirects
back, the helper exchanges the manifest code and writes credentials under
`var/github-app/` with mode `0600`.

Then install the app on the fixture repository and start Hootline with the
generated environment:

```sh
set -a
source .env.local
source var/github-app/<app-slug>.env
set +a
PIPELINE_FIXER_CONFIG=config/pipeline-fixer.fixture.yaml npm run dev -- --host 127.0.0.1 --port 3000
```

Verify the GitHub App can see the fixture repository before triggering a run:

```sh
source var/github-app/<app-slug>.env
npm run github-app:check-installation -- wakemeup0/hootline-pipeline-fixture
```

The generated app requests these repository permissions: Actions write, Checks
read, Contents write, Issues write, Metadata read, and Pull requests write. It
subscribes to `workflow_run` and `check_suite` events.

## Logging

Hootline emits structured logs through a small pino-based logger
(`agent/lib/logger.ts`). Every dynamic value is passed through the secret
redaction in `agent/lib/redact.ts` before it is written, so tokens, signatures,
private keys, and other secret-looking text never reach the log sink.

- **Level**: set `PIPELINE_FIXER_LOG_LEVEL` to one of
  `trace|debug|info|warn|error|fatal|silent` (default `info`). `EVE_LOG_LEVEL`
  separately controls Eve's own framework logs.
- **Format**: pretty, colorized output when stdout is a TTY (local dev);
  newline-delimited JSON otherwise (production/CI), suitable for log aggregators.
- **Namespaces**: every line carries an `ns` field — `channels.ci`,
  `tools.<name>`, `providers.github` / `providers.gitlab`, `lib.config`,
  `lib.sandbox`.
- **Correlation**: repair-lifecycle lines carry `attemptKey` (plus `provider`,
  `repoSlug`, `deliveryKey`) so one pipeline repair can be traced end-to-end —
  from webhook receipt, through tool calls, to publish/merge. Before a repair
  slot is claimed, lines correlate on `deliveryKey`.
- **Errors**: failures are logged with a stable `errorId` (via `logError`) that
  is safe to surface in user-facing messages for support correlation.

Example line (JSON mode):

```json
{"level":30,"ns":"channels.ci","provider":"github","repoSlug":"org/repo","deliveryKey":"github:abc","attemptKey":"github:org/repo:sha:99","msg":"repair slot claimed: dispatching repair session"}
```

The `test` script runs with `PIPELINE_FIXER_LOG_LEVEL=silent` so application
logs do not interleave with test output. Observability of the model loop itself
(turns, steps, tool spans) is available separately through Eve's
`eve/instrumentation` OpenTelemetry hook and is not wired up here.

## Loop Design

### Context contract

Each repair session starts with four seeded context blocks:

- `Pipeline fixer state`: the active `attemptKey`.
- `Normalized pipeline event`: provider, repo, ref, SHA, pipeline/run identifiers, actor, and PR/MR metadata when available.
- `Repository policy`: publish mode, allowed branches, allowed file globs, verification commands, sandbox network allowlist, attempt limits, and auto-merge settings.
- `Initial failure context collected by trusted runtime code`: redacted failed job metadata and log snippets, or a collection error.

The seeded context is a starting snapshot. The model should refresh with `get_failure_context` only when the logs are missing, stale, truncated across the root-cause area, or contradicted by later tool output. Repository files must be refreshed by staging the provider archive with `stage_repository_snapshot`; they are not preloaded in the prompt.

### Harness boundaries

- Provider tokens stay in app runtime; repository archives are copied into the sandbox.
- Tools derive the active event from `attemptKey` in session auth, so normal calls use `{}`.
- `stage_repository_snapshot` must run before repository reads, edits, checks, or publishing.
- `run_repo_checks` and `publish_fix` require a staged snapshot.
- `run_repo_checks` applies `sandboxNetworkAllow` before running configured verification commands.
- `publish_fix` reruns configured checks and rejects file paths outside policy before publishing.
- The default `web_fetch` and `web_search` tools are disabled; provider APIs are exposed only through narrow tools.

### AI SDK tooling

Hootline intentionally does not wrap the Eve agent in AI SDK `ToolLoopAgent` or add
`ai-sdk-tools` packages.

Eve already owns the durable model loop for this agent: session state, step replay,
compaction, streaming events, tool execution, sandboxed shell/file access, and
the app-runtime/sandbox trust boundary. Hootline's custom tools also bind every
provider-side action to the active `attemptKey`, repository policy, staged
snapshot, and publish checks. Adding a second tool loop inside the Eve turn would
duplicate those controls and make it easier for model-selected tools to drift
away from Hootline's deterministic policy gates.

AI SDK `ToolLoopAgent` can be reconsidered only for a contained subtask that does
not mutate provider state, accepts redacted context, has an explicit step budget,
and returns a compact structured result back through one Eve tool or subagent.
In that case, map `activeTools`, `toolChoice`, and `stopWhen` to Hootline policy
before exposing it to the model. The current `ai` dependency remains because Eve
0.11.2 declares it as a peer dependency.

`ai-sdk-tools` is also not part of the agent runtime today. Its artifact
streaming, state-store, and debugging utilities are useful for AI SDK application
UIs, but Hootline currently reports through Eve session events and provider
comments. Revisit those packages only when adding a dedicated dashboard or UI
channel that needs structured artifact rendering.

### Repair loop

The model is expected to run a bounded loop:

1. Inspect seeded context and stage `/workspace/repo`.
2. Tie the earliest causal CI error to the relevant source or configuration.
3. Make the smallest policy-allowed fix.
4. Run configured verification with `run_repo_checks`.
5. Publish verified changes with `publish_fix`, request a transient rerun with `rerun_pipeline`, or post a blocker with `post_provider_comment`.

`auto_merge` is deterministic: when a success webhook arrives for a recorded fixer branch, Hootline merges the recorded PR/MR without asking the model to monitor it. The `merge_change` tool remains available only for policy-approved manual recovery paths.

### Invariants

- Never expose tokens, authorization headers, webhook secrets, private keys, passwords, or secret-looking log text.
- Work only inside `/workspace/repo` after staging.
- Treat branch, path, publish-mode, attempt-count, network, and verification policy as hard constraints.
- Do not call a fix verified unless the configured checks passed in the current session or `publish_fix` returned a published result with passing verification.

## Verification

```sh
npm run typecheck
npm test
npm run check:model-matrix
ANTHROPIC_API_KEY=test PIPELINE_FIXER_MODEL_PROVIDER=anthropic PIPELINE_FIXER_MODEL=claude-sonnet-4-6 npm run info
ANTHROPIC_API_KEY=test PIPELINE_FIXER_MODEL_PROVIDER=anthropic PIPELINE_FIXER_MODEL=claude-sonnet-4-6 npm run build
```
