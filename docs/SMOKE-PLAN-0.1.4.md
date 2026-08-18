# AnchorClaw 0.1.4 smoke plan

Prepared on 2026-08-18. Execute this plan before publishing `0.1.4` to npm or
ClawHub.

## Objective

Prove that one immutable `0.1.4` package artifact works across the complete
supported OpenClaw transition:

- minimum supported legacy host: `2026.5.28`;
- current production legacy host: `2026.7.1` on `server-166`;
- native session-search target: `2026.8.1-beta.2`.

The smoke run must verify real runtime behavior, not only TypeScript
compatibility or ClawHub static validation.

## Executor model and handoff protocol

The full smoke run does not require the most expensive model for every step.
Recommended routing:

| Work | Recommended executor |
| --- | --- |
| planned pre-production Phases 0–3 and clean evidence collection | GPT-5.6 Terra with `high` reasoning |
| local commands, checksums, static validation, and evidence transcription | GPT-5.6 Luna with `high` reasoning, only when the exact procedure is already known |
| final code/diff review, production Phase 4, unexpected behavior, rollback, or release judgment | GPT-5.6 Sol/current frontier model |

Terra may execute Phases 0–3 when the run follows this document and no
unexplained result appears. Luna must not independently redesign the test,
invent compatibility workarounds, modify production configuration, decide a
rollback, or interpret an ambiguous PASS. Phase 4 requires the frontier model.

> [!WARNING]
> **Mandatory model-escalation gate:** when running on Terra or Luna, stop and
> ask the user to switch to GPT-5.6 Sol/current frontier model before analyzing
> or acting on any unexpected result. Do not attempt a fix, alter the runbook,
> continue to the next phase, install on production, roll back, or make a
> release decision until the user confirms the model switch.

The mandatory stop is triggered by any of the following:

- final review or modification of the `session-delta` implementation;
- an unexpected diff, packaged file, warning, validation result, or test
  failure;
- version, artifact, checksum, session-mode, or database-state mismatch;
- any result that is ambiguous, only partially observed, or inconsistent
  between exact OpenClaw versions;
- a proposed workaround, code/config change, data repair, migration response,
  or deviation from this runbook;
- production installation approval, rollback decision, or final publish/release
  judgment.

Use this handoff message and then end the turn without taking the blocked
action:

```text
STOP: для следующего шага нужен GPT-5.6 Sol/current frontier model.
Причина: <конкретное расхождение или high-risk решение>.
Уже проверено: <краткие факты и evidence>.
Ничего после обнаружения не менял. Переключи модель и напиши «продолжай».
```

Clean, expected execution on Terra does not require a switch between routine
phases. Luna must additionally stop before Phase 4 even if Phases 0–3 are clean;
it may not perform production installation or restart.

The executor must follow this protocol regardless of model:

1. Read this entire file, `WORKLOG-2026-08-17.md`, and the current `git status`
   before taking an action.
2. Preserve all pre-existing uncommitted work. Do not overwrite, discard, or
   silently include unrelated changes.
3. Create a separate `SMOKE-RESULTS-0.1.4.md` evidence file at execution time.
   Record each command, exact target version, exit status, relevant bounded
   output, and PASS/FAIL before continuing.
4. Execute phases in order. Do not begin production Phase 4 unless Phases 0–3
   are explicitly recorded as PASS.
5. Never guess an OpenClaw, ClawHub, service-manager, or package-manager
   command. Inspect the installed command's `--help` or existing deployment
   procedure first and record the resolved command.
6. Never rebuild the candidate between targets. Verify its SHA256 immediately
   before every installation.
7. Treat a missing observation as NOT TESTED, never PASS. A plausible model
   response is not proof of prompt placement, deduplication, or session mode.
8. Stop on the first unexplained warning, version mismatch, checksum mismatch,
   duplicate, unexpected database mutation, or deviation from this plan.
9. On a stop, preserve logs and state, make no speculative fix, emit the
   mandatory model-switch handoff above, and wait for the user.
10. Obtain the user's explicit confirmation immediately before production
    installation, production restart, rollback, publishing, or destructive
    cleanup. Earlier approval of the plan is not approval of those actions.
11. Do not update production OpenClaw, publish a package, merge branches, create
    tags, or change the release version during smoke execution.
12. End every phase with a short checkpoint containing: target, artifact SHA,
    tests run, PASS/FAIL/NOT TESTED, anomalies, and next authorized action.

Recommended use of the current frontier-model budget:

- review and freeze the final `session-delta` diff once before Phase 0;
- review only anomalies that Terra cannot resolve from direct evidence;
- review the completed evidence table before the final release decision.

Routine command execution and clean PASS collection should remain on Terra or,
for tightly bounded mechanical steps, Luna.

## Release boundary

This plan tests the existing `0.1.4` behavior:

- durable PostgreSQL projection through typed `before_prompt_build` as
  `prependSystemContext`;
- DB-backed daily startup context through `prependContext` on the first turn;
- frozen local session-file implementation on legacy OpenClaw;
- native `sessions_search` and `sessions_history` delegation on new OpenClaw;
- one process-wide legacy transcript-update subscription.

Do not include the planned `0.1.5` changes:

- durable projection through `agent:bootstrap`;
- durable `contextInjection=continuation-skip` parity;
- narrowed `startupContext.applyOn` handling;
- RP/story/search-only memory scopes or relevance filtering.

The server uses default `startupContext.applyOn` behavior, so the deferred
custom narrowing does not affect this release smoke.

## Version matrix

| OpenClaw | Environment | Expected session mode | Purpose |
| --- | --- | --- | --- |
| `2026.5.28` | isolated temporary runtime | legacy | minimum-version compatibility and frozen adapter |
| `2026.7.1` | `server-166` production installation | legacy | actual deployed host, gateway, PostgreSQL, and Telegram sanity |
| `2026.8.1-beta.2` | isolated temporary runtime | native | native delegation and deleted-SDK-export compatibility |

Do not upgrade or downgrade the production OpenClaw installation as part of
this test. The minimum and native targets run in isolated environments with
their own config directories, ports, workspaces, and PostgreSQL databases.

## Safety and isolation

Before execution:

1. Use dedicated temporary agents/workspaces for the isolated runtimes.
2. Use a separate PostgreSQL database for each isolated runtime. Do not point
   either runtime at the production AnchorClaw database.
3. Keep production config and the currently installed plugin bundle available
   for rollback.
4. Do not log or export the production durable-memory projection.
5. Do not enable full prompt previews on the production workspace. Use canary
   records, status output, bounded log inspection, and database counts.
6. Do not publish, tag, merge, or update production OpenClaw during the smoke
   run.

Every created resource must carry one run identifier:

```text
ANCHORCLAW_SMOKE_<UTC timestamp>
```

Derive distinct canaries from it:

```text
ANCHORCLAW_SMOKE_DURABLE_<timestamp>
ANCHORCLAW_SMOKE_DAILY_<timestamp>
ANCHORCLAW_SMOKE_SESSION_<timestamp>
```

Record the exact identifiers before testing so cleanup can target explicit
rows and paths without broad deletion.

## Phase 0 — finish and freeze the candidate

The current `session-delta` singleton change must be reviewed before building
the candidate. It prevents multiple plugin runtime instances from registering
duplicate process-wide transcript listeners.

Required local gates:

```text
npm run typecheck
npm run build
npm test
git diff --check
```

Then:

1. Review the complete branch diff, including the final packaged `dist` files.
2. Inspect `npm pack --dry-run`; reject unexpected source, secrets, backups, or
   development artifacts.
3. Commit and push the final `refactoring` branch.
4. Build one npm tarball from that exact clean commit.
5. Record:
   - Git commit SHA;
   - tarball filename;
   - tarball SHA256;
   - package version (`0.1.4`);
   - build timestamp.
6. Use this same tarball for all three runtime targets. Do not rebuild between
   environments.

Because production already reports package version `0.1.4`, the version string
alone is not sufficient proof of the installed candidate. Compare the recorded
tarball/installed-file checksum and commit provenance.

## Phase 1 — static package validation

Run ClawHub validation against all exact targets:

```text
clawhub package validate <path-to-plugin> --openclaw-version 2026.5.28
clawhub package validate <path-to-plugin> --openclaw-version 2026.7.1
clawhub package validate <path-to-plugin> --openclaw-version 2026.8.1-beta.2
```

Pass criteria:

- zero compatibility breakages;
- no `sdk-export-missing` finding;
- no prompt-injection registration/security finding;
- only the already understood non-blocking `uiHints` P2 warning may remain.

Also scan the packed JavaScript and package exports to prove that
`openclaw/plugin-sdk/memory-core-host-engine-qmd` is absent.

## Phase 2 — isolated minimum host (`2026.5.28`)

Create a temporary runtime with:

- exact OpenClaw `2026.5.28`;
- the frozen candidate tarball;
- a temporary config directory and unused port;
- a temporary workspace/agent;
- a dedicated empty PostgreSQL database.

### Startup and health

Verify:

- OpenClaw reports exactly `2026.5.28`;
- AnchorClaw reports `0.1.4` and the installed files match the candidate;
- gateway reaches a stable ready state without a restart loop;
- AnchorClaw migrations complete once;
- status reports ready, not disabled or degraded;
- no missing SDK export or plugin registration warning appears.

### Common memory behavior

Using the temporary agent:

1. Store the durable canary with `memory_store`.
2. Read it using `memory_get` and find it using `memory_search`.
3. Write the daily canary with `memory_log`.
4. Start a new session and verify the first-turn context can use both canaries.
5. Send a continuation turn and verify logs/DB activity show daily startup
   injection was skipped while durable memory remains available.
6. Verify each canary exists exactly once in its intended storage surface.
7. Exercise content containing triple backticks and the extractor trust-marker
   strings; it must remain quoted data and must not terminate or spoof the
   trusted wrapper.

Do not treat a model answer alone as sufficient evidence. Correlate it with
hook logs, status output, and exact database row counts without dumping other
memory content.

### Legacy session behavior

1. Confirm AnchorClaw selects legacy session-search mode.
2. Write a message containing the session canary.
3. Wait for the documented delta debounce/retry window.
4. Verify one effective transcript listener is registered for the process.
5. Verify the relevant session-index state is updated once, with no duplicate
   logical record or repeated retry loop.
6. Search for the session canary through AnchorClaw and retrieve the matching
   session content.
7. Restart the temporary gateway.
8. Add another unique session message and repeat the search.
9. Confirm restart restored one listener rather than accumulating a second
   subscription.

Pass only if the frozen local legacy implementation works without importing
the removed OpenClaw SDK alias.

## Phase 3 — isolated native host (`2026.8.1-beta.2`)

Create a second clean temporary runtime with the exact beta version, the same
candidate tarball, and a new isolated workspace/database/port.

Repeat the startup, health, durable, daily, and memory-tool checks from the
minimum host.

### Native session behavior

1. Confirm AnchorClaw selects native session-search mode.
2. Confirm the legacy transcript listener and AnchorClaw legacy delta-indexing
   path do not start.
3. Write a message containing the session canary.
4. Verify session search delegates to native `sessions_search`.
5. Verify session retrieval delegates to native `sessions_history`.
6. Confirm both return the intended test session without an AnchorClaw-owned
   legacy index write.
7. Restart the runtime and repeat one search to prove native behavior survives
   reload.

The native runtime fails if it silently falls back to legacy behavior or if
loading the package reaches the deleted SDK export.

## Phase 4 — production legacy host (`server-166`, `2026.7.1`)

Run this phase only after both isolated targets pass.

### Baseline and rollback capture

Before installation, record without exposing secrets:

- current OpenClaw version and service state;
- current AnchorClaw package version and installed bundle checksum;
- current plugin status/doctor summary;
- current config checksum and relevant non-secret settings;
- production database migration version and aggregate row counts;
- recent AnchorClaw/gateway error count;
- exact rollback bundle/config locations.

Do not alter production data during baseline collection.

### Install and restart

1. Install the already-tested candidate tarball; do not build on the server.
2. Verify the installed files match the recorded candidate checksum.
3. Restart the gateway once.
4. Confirm it reaches a stable ready state and remains stable through the
   initial observation window.
5. Confirm OpenClaw remains `2026.7.1`, AnchorClaw reports `0.1.4`, and session
   mode is legacy.
6. Confirm no migration, SDK-export, prompt-security, duplicate-listener, or
   database errors appear.

### Production smoke

Prefer a temporary production-side smoke agent/workspace if routing permits.
If an isolated agent cannot exercise the Telegram route, keep database canary
testing isolated and perform only the final short sanity sequence in the real
Telegram workspace.

Required checks:

1. One `/new`/startup exchange completes normally.
2. One ordinary continuation exchange completes normally.
3. Durable context is available without the content-sticking regression.
4. Daily startup context is not added again on continuation.
5. A session canary becomes searchable through legacy session search after the
   delta window.
6. One explicit `memory_search` returns expected scoped results.
7. No duplicate daily/session records or repeated transcript processing appear.
8. Restart the gateway once more, repeat a session update/search, and confirm
   only one effective transcript listener remains.

The human Telegram check is qualitative evidence for response coherence. Hook
logs, status, and database counts remain the objective evidence for injection
and deduplication.

## Failure and rollback criteria

Stop the production smoke and roll back if any of the following occurs:

- gateway crash or restart loop;
- plugin disabled/degraded for a new reason;
- database migration failure or unexpected schema mutation;
- missing SDK export;
- prompt-injection/security warning introduced by the candidate;
- durable data appears in user context instead of system context;
- daily context is injected again on a continuation turn;
- duplicate memory/session rows or multiple effective transcript listeners;
- legacy search fails on `2026.7.1`;
- material response-content regression compared with the pre-install baseline.

Rollback means restoring the captured previous plugin bundle and config,
restarting the gateway, and repeating the read-only health check. Do not roll
back database migrations destructively. If a migration unexpectedly ran,
preserve evidence and diagnose before any database reversal.

## Cleanup

After each isolated runtime:

1. Record the final PASS/FAIL evidence.
2. Stop its gateway.
3. Remove only its explicit temporary config, workspace, and package directory.
4. Drop only its explicitly named temporary PostgreSQL database after verifying
   the connection target twice.

After production smoke:

1. Remove the exact durable/daily/session canary records through supported
   AnchorClaw operations where possible.
2. Verify searches no longer return the canaries.
3. Remove only the explicitly created temporary smoke workspace/agent.
4. Confirm production aggregate counts differ only by expected real activity.
5. Preserve concise logs, checksums, and results; do not preserve memory
   payload dumps.

## Evidence record

Fill this table during execution:

| Item | Result/evidence |
| --- | --- |
| Git commit SHA | |
| Candidate tarball | |
| Candidate SHA256 | |
| ClawHub `2026.5.28` | |
| ClawHub `2026.7.1` | |
| ClawHub `2026.8.1-beta.2` | |
| Runtime `2026.5.28` | |
| Runtime `2026.7.1` | |
| Runtime `2026.8.1-beta.2` | |
| Durable injection | |
| Daily first-turn/continuation | |
| Legacy session search | |
| Native session delegation | |
| Single listener after restart | |
| Production Telegram sanity | |
| Canary cleanup | |
| Rollback required | |

## Final release gate

Publishing is allowed only when:

- all three exact runtime targets pass;
- static validation has zero breakages;
- the candidate tested on every target is byte-identical;
- production is stable after the final restart/observation window;
- all smoke canaries are removed;
- no unexplained error, warning, duplicate, or behavioral discrepancy remains;
- the release decision is explicitly confirmed after reviewing this evidence.
