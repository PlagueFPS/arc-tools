# Native account alarm attribution

This unit adds fixture diagnostics. It does not accept Unit 5 or identify the cause of the historical failed run. Stage `test-tenant-8c6e6c0f-18de621764a7` remains failed with 28 passing cases, one failing case, and 631 assertions.

## Candidate and scope

Parent `84b28fc` received exactly `f5d3c2f`, `d9d1650`, and `a97ae06`, once each, as `9d5b7d6`, `ab7e9e1`, and `20022e3`. Before instrumentation, `git diff a97ae06 -- apps packages tests scripts bun.lock package.json` was empty. The imports needed no conflict resolution and preserved the parent's audit history.

Instrumentation changes stay in `tests/cloud`. This document is the only added documentation. Application sources, stack declarations, workflows, environment files, pins, and root review documents receive no instrumentation edits. The production HTTP provider and account policy remain unchanged. Existing cloud assertions, timeouts, poll limits, poll spacing, fixture clocks, provider responses, and retry policy remain unchanged.

## Data and ownership

`AccountAttribution` contains bounded activation events and validation invocation records. Each invocation has a UUID, fixture activation UUID, operation and alarm-run context, SHA-256 credential fingerprint, wall-clock start, and optional completion time and outcome. Outcomes distinguish success, failure, and interruption. No token, authorization header, response body, exception body, or secret enters these records. Activation, account construction, explicit reconstruction, alarm entry, and alarm completion events persist independently of the in-memory activation.

`ProviderAttribution` retains the existing global counters and adds fingerprint counts and ordered HTTP request events. Each event names its UUID, wall-clock receipt time, fingerprint, credential count, and global validation count. The global increment, credential increment, and event append share the provider's existing transaction. Provider snapshots read the counters and events in one transaction. The provider fixture constructor is exposed as `makeProviderFixture` so the local proof runs the actual controlled provider implementation.

Each account journal retains 128 activation events and 128 invocations. The provider retains 128 HTTP events and 128 distinct credential counts. Explicit dropped totals expose truncation. A credential evicted from the bounded count map starts its retained count again if it returns. Counts are exact while that fingerprint remains retained. No truncation is expected for the canonical suite, but retained dropped totals must be inspected before interpreting counts.

`NativeAlarmSnapshot` reads account state, native schedule, live alarm-run count, and the durable journal in one transaction. Its completed alarm observation separately names the completing activation, completion time, observed lease and schedule, and validation invocation IDs for that run. A saved completed run does not imply that the live object or global provider counter has stopped changing.

The `prepared`, `early-account`, `early-provider`, `late-account`, `late-provider`, and `final` boundaries emit safe JSON to the cloud console and `.cloud-tests/<stage>/native-alarm-attribution.jsonl`. They include stage and wall-clock time. The provider snapshots used by the original count assertions are the exact snapshots retained at the provider boundaries. Final diagnostics attempt each account and provider independently, even after a failed assertion. A failed diagnostic read records unavailability without replacing the original failure.

The target journal is served only through the existing test fixture. `/attribution` exposes the other account fixture's journal without calling account setup or status. Production account objects are not wrapped. Requests whose fingerprints appear in neither account fixture journal can be distinguished from the target but cannot be assigned to a particular production account activation by these records alone.

## Local proof

Use the pinned executable first in PATH.

```sh
export PATH=/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin:$PATH
bun install --frozen-lockfile
bun test ./tests/cloud/alarm-attribution.test.ts
TURBO_FORCE=true bun run test
TURBO_FORCE=true bun run check-types
bun run lint
```

The focused proof runs the production account and storage adapter against the unchanged production HTTP provider, a loopback HTTP server, and the actual extracted provider fixture constructor. Manual clocks and explicitly invoked alarms make the competing sequences reproducible. The local storage model clones persisted values and serializes transactions; it does not emulate Cloudflare activation scheduling.

Both focused tests pass with 30 assertions. Global validation counts are 2 at baseline, 2 at the early leased alarm, 3 after target recovery, 4 after another account's explicit reconstruction, and 5 after another target reconstruction. Scoped counts are respectively target 1 and other 1, target 1 and other 1, target 2 and other 1, target 2 and other 2, then target 3 and other 2. The target invocation records name alarm runs 2 and 3 on distinct activations. A previously captured completed snapshot retains two invocation records while the live journal gains a third.

The second test verifies the same typed failure and actual fiber interruption, retained completion outcomes, bounded account and HTTP records, exact global totals after truncation, and secret-free serialized observations. These are instrumentation proofs, not evidence that either simulated sequence caused the historical cloud failure.

The uncached default suite passes 295 tests and 1,494 assertions. Uncached typechecking passes five workspace tasks and root TypeScript. Lint checks 126 files. A comparison against imported candidate `20022e3` confirms the original native-alarm assertion outcomes and timing directives remain present and production paths are unchanged.

Local logs are `/tmp/arc-attribution-proof.log`, `/tmp/arc-attribution-tests.log`, `/tmp/arc-attribution-types.log`, and `/tmp/arc-attribution-lint.log`.

## Authorized cloud experiment

One disposable canonical tenant run is authorized from this checkout after the source commit. It uses `bun run scripts/cloud-test.ts tenant`, the existing `Cloudflare.state()` harness, and normal independent teardown. No second run, business retry, warmup, production deployment, persistent staging deployment, or real Twitch or Discord mutation is authorized. Additional diagnostic reads and writes can change scheduling, so a successful instrumented execution cannot establish a historical cause.

The stage, source revision, result, hashes, observations, and independent cleanup evidence will be appended after that single execution.
