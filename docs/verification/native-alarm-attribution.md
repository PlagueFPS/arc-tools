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

The single execution used source commit `448f1a209f940a2df64130349373067a7ad92313` and stage `test-tenant-03d0007a-b5292566a994`. It passed 29 cases and 631 assertions. The native alarm case passed in 11,209.48 ms. `result.json` records `testResult: 0` and `cleanupResult: 0`. There was no second run.

The resource journal names seven Workers and ten namespaces. The normal suite destruction completed, and the independent cleanup process verified zero Workers and zero namespaces, absent stage state entries and output, and retained control infrastructure. The console retains the exact `CLEANUP VERIFIED` result. No production or persistent staging deployment or real provider mutation occurred.

## Observed cloud attribution

The prepared provider snapshot contains 19 global validations and one validation for target fingerprint `ad538f02501212d49e8aa2e74d026432c47102bbffbff81638eeff71eb82ab30`. The early provider snapshot contains the same counts. The late provider snapshot contains 20 global validations and two target validations. The final provider snapshot retains those counts. All journal truncation totals are zero, and the retained attribution JSONL contains no raw synthetic app token, canary secret, access token, refresh token, or authorization header.

The target starts on fixture activation `44ba3a4a-a1e0-458d-94e2-afddf7d4f977`, records the requested reconstruction, and activates as `40db23db-8c07-4cec-bec2-06124047210c`. Both native alarm entries and completions belong to that second activation. Alarm run 1 records no validation invocation. Alarm run 2 records invocation `5c21c33e-bb28-4e0f-9a4a-78f1e49da848` with the target fingerprint, starting at Worker wall time `1792278307835` and completing successfully at `1792278307901`.

The only new provider validation request after the baseline is event `b7cd6393-80f7-4438-8cd7-552864e88215`, received at provider Worker wall time `1792278307891`. Its fingerprint matches the target invocation, its scoped count is 2, and its global count is 20. The completed alarm record names that invocation ID, a cleared lease, and matching intended and native schedules of `1792281902901`. The final target snapshot still has live run count 2, completed run count 2, two total validations including preparation, and no additional activation.

The final diagnostic read observes another activation of the other account fixture, with new activation and build events. Its invocation count remains 18 at both prepared and final boundaries. It contributes no validation within the observed native-alarm window. This observation does not establish why that other activation occurred.

Runner journal timestamps and Worker timestamps come from separate clocks. UUIDs, fingerprints, alarm-run context, transaction-scoped counts, and completion records establish correlation. Cross-process millisecond timestamps alone do not establish exact event ordering.

## Interpretation and next experiment

The historical failure did not reproduce. This run attributes the expected additional HTTP validation to target alarm run 2. It does not explain the historical count of 21. Neither the local forced-reconstruction proof nor a passing instrumented cloud execution establishes a historical cause. Additional diagnostic storage and HTTP activity can affect activation and scheduling.

A specific next diagnostic experiment would capture a completed second-alarm snapshot, explicitly reconstruct only that target, let its native alarm execute, and then read the unchanged global assertion. A paired other-account reconstruction would distinguish the two attribution signatures on Cloudflare. This would test whether the locally demonstrated sequence occurs under native scheduling. It would remain a diagnostic result and would not attribute the historical failure. No such experiment was executed, and it needs separate authorization.

Unit 5 remains unaccepted. No application fix or assertion relaxation is proposed by this unit.

## Retained artifacts

All artifacts live in `.cloud-tests/test-tenant-03d0007a-b5292566a994/` in this checkout. `artifact-hashes.json` records SHA-256 for every retained file. The directory contains the original resource, run, result, and timing journals, the six safe attribution boundaries, a derived attribution summary, the full console, and copies of the local verification logs. The original console also remains at `/tmp/arc-attribution-cloud.log`.

The principal SHA-256 values are:

```text
result.json                      da6ead148fac5520dd37f4304606f8904a7973d97c12d3a30c2680ecae9505b8
resources.json                   097b1048df6d3767836150a737ca51929980eb9aa5a83edb7a219e945042cb60
native-alarm-attribution.jsonl    66c494c665b6d15dddb638fc88b9d9425c378465454130b06be350942a5d63b6
attribution-summary.json         6e743b1ea685f731470cf1f37d79d9509ad119c0c795b4a9d65dbfc1df65b473
cloud-console.log                7549d1d635fdaf58e32ed907c1dedf53cee5c2d96d714288a3b9a9938e918dc5
```
