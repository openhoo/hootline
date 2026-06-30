# Hootline Architecture

Hootline is organized around Eve's filesystem-first agent layout. Files under
`agent/` are the authored agent surface; everything outside `agent/` is either
operator tooling, benchmark infrastructure, tests, or documentation.

## Agent Runtime

- `agent/channels/`: webhook entrypoints. Channel code verifies transport input,
  normalizes provider events, and delegates to the repair service.
- `agent/lib/repair-service.ts`: the repair orchestrator. It claims repair
  slots, resolves repo policy, seeds Eve sessions, handles provider-error
  retries, and releases delivery keys for provider redelivery when appropriate.
- `agent/lib/session-monitor.ts`: Eve stream observation and continuation
  policy. This is the only layer that interprets session events.
- `agent/lib/state.ts`: durable JSON state for deliveries, attempts, rerun
  requests, publish records, and auto-merge claims. It assumes one Node process
  per state file.
- `agent/lib/providers/`: provider adapters. GitHub, GitLab, and simulated
  GitHub share the `ProviderClient` contract from `common.ts`.
- `agent/lib/sandbox.ts`: sandbox filesystem and verification helpers. Tools and
  providers call this layer for changed-file collection and policy checks.
- `agent/tools/`: Eve tools exposed to the model. Tools should stay thin: parse
  input, resolve the active attempt, call trusted runtime helpers, update state,
  and return model-safe output.

## Benchmarks

- `benchmarks/fixtures/projects/`: realistic first-party fixture applications
  used by the simulated provider benchmark. Each project has its own policy,
  source tree, tests, and verification command.
- `scripts/fixture-scenarios.mjs`: scenario catalog and mutation helpers for
  simulated benchmark scenarios, including project metadata and template paths.
- `scripts/simulated-benchmark.mjs`: primary benchmark CLI. It runs Hootline
  against an isolated local Eve app workspace and the simulated GitHub provider.
- `scripts/benchmarks/common.mjs`: shared benchmark row, status, summary, and
  retry-boundary helpers.
- `scripts/benchmarks/simulated-app.mjs`: simulated benchmark app-workspace and
  env-file loading helpers.

The simulated benchmark is the default validation path for framework or agent
changes.

## Operating Boundaries

- Keep provider credentials, webhook verification, repository snapshots,
  publishing, and merge/rerun side effects inside trusted runtime code.
- Keep model-visible tools deterministic and small. A tool should not own repair
  orchestration or provider retry policy.
- Keep shared benchmark helpers in `scripts/benchmarks/`.
- Keep generated Eve/build/runtime data out of source. `.eve/`, `.output/`,
  `.workflow-data/`, and `var/` are ignored local artifacts.
