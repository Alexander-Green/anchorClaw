# AnchorClaw 0.1.4 smoke results

Execution started on 2026-08-18 from branch `refactoring`.

## Candidate identity

| Item | Value |
| --- | --- |
| Git commit SHA | pending clean candidate commit |
| Package version | `0.1.4` |
| Tarball | pending |
| Tarball SHA256 | pending |
| Build timestamp | pending |

## Phase 0 — review and freeze

Status: READY TO COMMIT AND FREEZE.

### Final `session-delta` review

Initial review found a hot-reload ownership race in the uncommitted singleton
listener change: a new runtime could observe the old shared listener and return,
then lose all transcript events when the old runtime cleaned up.

The implementation was corrected before freezing the candidate:

- one physical OpenClaw transcript listener owns an ordered set of runtime
  consumers;
- the newest live runtime receives events;
- cleanup in either overlap order preserves a valid consumer;
- the physical listener is removed only after the final consumer leaves;
- a stale process-global entry from the earlier module shape is unsubscribed
  and replaced.

Verification completed after the correction:

```text
npm test -- --run src/plugin/session-delta.test.ts
PASS: 1 file, 7 tests

npm run typecheck
PASS

git diff --check
PASS
```

Full local gates completed after the correction:

```text
npm run typecheck
PASS

npm run build
PASS

npm test
PASS: 46 files, 396 tests

git diff --check
PASS
```

Package inspection:

- `npm pack --dry-run --json` initially failed because the environment's
  default user npm cache is read-only (`EROFS`); no package operation ran;
- repeating with the explicit writable cache `/tmp/anchorclaw-npm-cache`
  passed;
- package: `@alexandrgreen/anchorclaw@0.1.4`;
- packed entries: 270;
- unpacked size: 2,689,832 bytes;
- expected `dist`, migrations, manifest, package metadata, public docs, and
  logo were present;
- source tests, smoke/future worklogs, secrets, backups, and temporary files
  were absent;
- scans of `src` and built `dist` found no
  `openclaw/plugin-sdk/memory-core-host-engine-qmd`, legacy
  `registerHook("before_prompt_build", ...)`, or `before_agent_start` usage.

Candidate commit and immutable tarball identity remain pending.

## Static validation

Status: NOT TESTED.

| Target | Result |
| --- | --- |
| OpenClaw `2026.5.28` | NOT TESTED |
| OpenClaw `2026.7.1` | NOT TESTED |
| OpenClaw `2026.8.1-beta.2` | NOT TESTED |

## Runtime validation

| Target | Mode | Result |
| --- | --- | --- |
| OpenClaw `2026.5.28` | legacy | NOT TESTED |
| OpenClaw `2026.7.1` (`server-166`) | legacy | NOT TESTED |
| OpenClaw `2026.8.1-beta.2` | native | NOT TESTED |

## Feature evidence

| Check | Result |
| --- | --- |
| Durable injection | NOT TESTED |
| Daily first-turn/continuation | NOT TESTED |
| Legacy session search | NOT TESTED |
| Native session delegation | NOT TESTED |
| Single listener after restart | NOT TESTED |
| Production Telegram sanity | NOT TESTED |
| Canary cleanup | NOT TESTED |
| Rollback required | NOT TESTED |

## Phase checkpoints

### Phase 0 checkpoint

- Target: local candidate workspace.
- Artifact SHA: pending.
- Tests run: targeted and full tests, typecheck, build, diff check, package
  dry-run, forbidden-import/hook scan.
- Result: READY TO COMMIT AND FREEZE.
- Anomalies: hot-reload listener ownership race found and fixed before freeze.
- Next action: candidate commit/push and immutable tarball creation.
