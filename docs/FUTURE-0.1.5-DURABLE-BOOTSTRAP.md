# AnchorClaw 0.1.5 — injection parity follow-up

Research recorded on 2026-08-18. This document describes a proposed behavior
change for the next release. It is intentionally **not** part of the `0.1.4`
bugfix scope.

## Release scope

Ship two separate injection-parity changes in `0.1.5`:

1. move durable `MEMORY.md` projection into OpenClaw bootstrap;
2. make DB-backed daily startup context honor `startupContext.applyOn`.

They share a release and validation matrix, but they are not the same runtime
mechanism. Durable memory belongs to workspace bootstrap; daily memory remains
a one-shot user-context prelude.

Neither change belongs in the `0.1.4` bugfix scope. The server uses the default
`startupContext.applyOn` behavior, so deferring its explicit handling does not
change current production behavior.

## Durable memory decision

In `0.1.5`, move the PostgreSQL-backed durable `MEMORY.md` projection from the
typed `before_prompt_build` prompt hook to OpenClaw's `agent:bootstrap` hook.

The projection must remain virtual:

- PostgreSQL stays authoritative;
- durable facts and notes must not be copied back into a physical `MEMORY.md`;
- the physical file remains only an AnchorClaw compatibility marker/stub;
- AnchorClaw replaces that stub's bootstrap content in memory for the current
  run.

This is a release-level behavior change, not another `0.1.4` patch. It changes
which OpenClaw lifecycle owns durable injection and makes the host's
`contextInjection` policy apply to AnchorClaw memory.

## Current `0.1.4` behavior

AnchorClaw registers the official typed hook:

```ts
api.on("before_prompt_build", handler, ...)
```

It returns the durable projection as `prependSystemContext`. That placement is
correct and fixed the earlier content regression caused by using
`prependContext` on every turn.

However, this hook runs after OpenClaw has decided which workspace bootstrap
files to inject. Its public context does not expose the core bootstrap decision
or a reliable `isContinuationTurn` value. Consequently, AnchorClaw currently
injects durable memory on every turn, even when the host is configured with:

```json
{
  "agents": {
    "defaults": {
      "contextInjection": "continuation-skip"
    }
  }
}
```

This has parity with OpenClaw's default `contextInjection="always"`, but not
with `continuation-skip` or `never`.

`before_prompt_build` itself is **not legacy**. It is the modern public typed
prompt hook. The legacy/misused form was registering prompt events through
`api.registerHook("before_prompt_build", ...)`, and the deprecated neighboring
path is `before_agent_start`. Do not describe the current hook as a “legacy
fallback”; if retained, call it a compatibility or direct-prompt fallback.

## Why `agent:bootstrap` is the correct integration point

OpenClaw builds workspace bootstrap files before constructing the final system
prompt. The documented internal `agent:bootstrap` hook can mutate
`context.bootstrapFiles` during that process.

Replacing the existing `MEMORY.md` stub entry's in-memory `content` lets core
own all of its normal bootstrap behavior:

- `contextInjection="always"`;
- `contextInjection="continuation-skip"`;
- `contextInjection="never"`;
- restoration after compaction;
- heartbeat, cron, subagent, and lightweight-run routing;
- `bootstrapMaxChars` and `bootstrapTotalMaxChars` limits;
- any future core changes made in this bootstrap pipeline.

This is preferable to recreating continuation detection inside AnchorClaw.
Core uses transcript bootstrap markers, compaction ordering, run kind, and
other state unavailable in the public `before_prompt_build` context.
`messages.length` is not a safe substitute.

Relevant upstream references:

- [OpenClaw agent loop](https://docs.openclaw.ai/agent-loop)
- [OpenClaw PR #97281: preserve mutable internal-hook context](https://github.com/openclaw/openclaw/pull/97281)

## Compatibility findings

The research compared the package's supported minimum and the two relevant
newer targets:

- OpenClaw `2026.5.28` — minimum package/dev version;
- OpenClaw `2026.7.1` — version currently installed on `server-166`;
- OpenClaw `2026.8.1-beta.2` — ClawHub validation target.

`agent:bootstrap` exists on these versions, but there is an important mutation
difference:

- before `2026.7.1`, the plugin registry wrapper shallow-cloned
  `event.context`; assigning a new array to `event.context.bootstrapFiles`
  could be lost;
- the shallow clone retained the nested array reference, so mutating the
  existing array in place (index assignment or `splice`) should work on
  `2026.5.28`;
- OpenClaw PR #97281 fixed mutable context propagation in `2026.7.1`.

The old-version in-place behavior is a source-based conclusion and must be
proved with an exact `2026.5.28` runtime contract test before implementation is
accepted.

There is also a routing difference around `2026.8.1`: newer core versions apply
some session filtering after the hook, while older versions may filter before
it. Therefore the implementation should replace an already selected
`MEMORY.md` bootstrap entry. It must not blindly append a new virtual file,
which could bypass old-core filtering and inject durable memory into unintended
run types.

## Proposed implementation constraints

1. Register `agent:bootstrap` through its supported internal-hook API.
2. Find the existing workspace `MEMORY.md` bootstrap entry using normalized
   path identity, not display text.
3. Replace only that entry's `content`, mutating `bootstrapFiles` in place for
   compatibility with `2026.5.28`.
4. Keep the existing physical file as a harmless marker/stub. On a clean
   workspace, ensure the stub exists through the normal import/bootstrap setup
   path rather than appending an unfiltered virtual bootstrap entry.
5. Continue resolving workspace and agent scope per runtime invocation; never
   reuse another workspace's projection.
6. Preserve the current unavailable-memory warning semantics, but place any
   warning through the same selected `MEMORY.md` entry.
7. Do not change daily-memory injection in this work. Daily files remain
   untrusted first-turn startup context and are a separate mechanism.
8. Do not add RP/story/search-only scopes or relevance filtering. Those are
   separate product features.

## Internal hooks disabled: unresolved product policy

`agent:bootstrap` depends on OpenClaw internal hooks being enabled. They are
enabled by default, but an operator can explicitly set
`hooks.internal.enabled=false`.

Two policies are possible and must be chosen deliberately during `0.1.5` work:

### A. Fail/degrade loudly (strict parity)

Do not inject durable prompt memory when internal hooks are disabled. Surface a
clear status/doctor diagnostic explaining that virtual `MEMORY.md` bootstrap
requires internal hooks.

Advantages: host `contextInjection` semantics remain exact and there is no
hidden behavior difference. Disadvantage: durable prompt memory disappears
until configuration is corrected.

### B. Typed `before_prompt_build` compatibility fallback

Retain the current `api.on("before_prompt_build", ...)` path only when the
bootstrap hook cannot operate.

Advantages: durable prompt memory remains available. Disadvantage: strict
`continuation-skip` parity is impossible because this hook lacks core's
continuation/bootstrap decision. A fallback could honor `always` and `never`,
but `continuation-skip` would necessarily be degraded or approximated.

Do not silently run both paths: that would duplicate durable context. If policy
B is selected, registration/runtime ownership needs an explicit single-owner
guard and a visible degraded-mode diagnostic.

## Daily startup `applyOn`

### Current `0.1.4` behavior

AnchorClaw reproduces OpenClaw's recent-daily-memory startup prelude from
PostgreSQL because core cannot directly read the virtual DB-backed
`memory/YYYY-MM-DD.md` paths.

The current typed `before_prompt_build` handler:

- injects daily memory only when the prepared session history is empty;
- skips continuation turns;
- honors `startupContext.enabled`, `dailyMemoryDays`, `maxFileChars`, and
  `maxTotalChars`;
- does not distinguish whether the new session was created by `/new` or
  `/reset`.

The default `applyOn` behavior is both actions, so the current server and normal
default configurations already behave as intended. A narrowed configuration
such as `applyOn: ["new"]` or `applyOn: ["reset"]` is not currently honored.

### Why `before_prompt_build` alone is insufficient

Across OpenClaw `2026.5.28`, `2026.7.1`, and `2026.8.1-beta.2`, the public
`before_prompt_build` event contains `prompt` and `messages`, while its hook
context contains runtime/session identity. Neither exposes `startupAction` or
the result of core's `shouldApplyStartupContext` decision.

Do not infer the action by parsing OpenClaw's synthetic startup prompt. Its text
is private implementation detail and currently describes `/new` and `/reset`
together. Do not use `before_reset` as the primary bridge either: OpenClaw
dispatches it fire-and-forget after transcript loading, which can race the new
model run.

### Proposed typed lifecycle bridge

Use the official typed `session_end` event, which exposes:

```ts
{
  reason: "new" | "reset";
  nextSessionId?: string;
}
```

Implementation outline:

1. Register a synchronous `api.on("session_end", ...)` observer.
2. For `reason="new"` or `reason="reset"` with a valid `nextSessionId`, store a
   bounded, short-lived `nextSessionId -> action` entry.
3. On the first `before_prompt_build` invocation, resolve the action from the
   hook context's `sessionId`.
4. Apply OpenClaw's semantics: an absent or empty `applyOn` permits both;
   otherwise inject only when the array contains the resolved action.
5. Consume the entry after the first applicable prompt and clean up expired
   entries so aborted/reset sessions cannot leak state.
6. Scope any process-wide registry so multiple plugin runtime instances do not
   create duplicate observers or cross-wire sessions.

For a completely fresh session with no preceding `session_end`, classify the
startup action as `new`. This preserves the existing first-session behavior and
matches OpenClaw's normal new-session classification.

One unavoidable edge remains: the first-ever command may be `/reset` while no
previous session exists, so no `session_end` mapping is available. The public
prompt hook cannot distinguish that case from a fresh `new` session. Document
and test the fallback; exact handling would require OpenClaw to expose
`startupAction` directly.

This bridge uses public typed plugin hooks and must not require internal hooks,
prompt parsing, or legacy `registerHook("before_prompt_build", ...)` behavior.

## Required validation matrix

Run exact-version integration tests against `2026.5.28`, `2026.7.1`, and
`2026.8.1-beta.2` covering:

| Scenario | Expected durable projection |
| --- | --- |
| `always`, first turn | injected once through `MEMORY.md` bootstrap |
| `always`, continuation | injected once |
| `continuation-skip`, first/full-bootstrap turn | injected once |
| `continuation-skip`, safe continuation | omitted by core |
| `continuation-skip`, post-compaction turn | restored by core |
| `never` | omitted |
| heartbeat/cron/subagent/lightweight runs | exactly follows that core version's native `MEMORY.md` behavior |
| multiple workspaces/agents | correct isolated PostgreSQL projection |
| empty durable store | no synthetic facts and no duplicate context |
| database unavailable | defined warning/degraded behavior, injected at most once |
| internal hooks disabled | matches the selected product policy above |

Daily startup cases, on every exact OpenClaw target:

| Scenario | Expected daily projection |
| --- | --- |
| `applyOn` absent or empty, `/new` | injected once |
| `applyOn` absent or empty, `/reset` | injected once |
| `applyOn=["new"]`, `/new` | injected once |
| `applyOn=["new"]`, `/reset` | omitted |
| `applyOn=["reset"]`, `/new` | omitted |
| `applyOn=["reset"]`, `/reset` | injected once |
| `startupContext.enabled=false` | omitted without a DB query |
| continuation turn | omitted |
| concurrent sessions with different actions | no cross-session leakage |
| aborted session before its first prompt | mapping expires without leakage |
| first-ever session with no lifecycle mapping | classified as `new` |

Also verify:

- bootstrap character limits are applied exactly once by core;
- daily startup facts still appear only through their existing daily hook;
- `memory_search`, `memory_get`, maintenance, and session capture remain
  prompt-independent;
- the ClawHub validator reports no compatibility or prompt-injection security
  regression;
- installation does not restore durable content to disk;
- package, built artifact, and loaded server version all report `0.1.5` only
  when this behavior change is actually released.

## Release boundary

For `0.1.4`, keep the corrected `prependSystemContext` implementation and do
not fold this migration into an unpublished bugfix under the same version.

For `0.1.5`, implement the bootstrap migration and the typed daily `applyOn`
bridge, choose the disabled-internal-hooks policy, complete the exact-version
matrix, then update architecture, README, changelog, manifest/package version,
and server smoke-test notes.
