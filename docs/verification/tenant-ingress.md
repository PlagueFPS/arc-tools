# Tenant and signed ingress verification

Unit 3 implements the selected Candidate A contract on baseline `d22e51a`. Root owns independent review and integration. No production deployment, persistent staging deployment, live Twitch or Discord mutation, or nested delegation is authorized or performed.

Final acceptance is NOT VERIFIED. Deployment three passed all 15 inherited canonical cases and eight new cases, but failed four acceptance cases. The three-deployment authorization is exhausted. No fourth deployment was attempted. Application code matches the deployed `3a4ac15` candidate. Only test diagnostics and this evidence changed afterward. Root must resolve the fast private-response failures and authorize any further cloud run before accepting this unit.

## Contracts and implementation

`ingress.ts` verifies bounded original bytes before JSON decoding. Worker fetch stamps receipt before acquiring clients or constructing routes. Twitch verifies HMAC over ID, timestamp and bytes. Discord verifies Ed25519 over timestamp and bytes. Ingress checks protocol context before calling the tenant. Discord PING has no guild or tenant. The Worker returns a private initial response when a valid Discord tenant RPC fails or exceeds its original budget.

`tenant.ts` exposes `acceptTwitch` and `respondDiscord`. Its private recovery operation also serves native alarms. A schema-encoded snapshot owns identity, immutable deadlines, claims and replay records. Admission stores the first claim and useful alarm before registering immediate work with DO `waitUntil`. Network operations run outside transactions. Generation, activation and lease fencing prevent stale completion. Twitch freezes the complete presentation plan and exact account payload before dispatch. Attempt IDs use immutable work identity and part index. Unknown account completion retains that attempt. Ambiguity stops remaining parts.

Discord computes inline. Duplicates use read-only polling, at most 100 reads spaced at least 25ms, until the original 2350ms compute cutoff. A reconstructed activation commits a private interruption. The Worker bounds RPC at original receipt plus 2700ms. These margins remain hypotheses until measured on cloud. There is no token persistence, defer or later message API.

Capacity is 64 retained records, eight active records, and 120 KiB including outstanding 8 KiB reservations. Only expired records are reclaimed. Terminal Twitch records drop invocation, target and plan. Discord retains a bounded token-free response. No idle tenant alarm is scheduled.

`presentation.ts` preserves complete text within conservative UTF-16 limits. Twitch uses a non-command prefix and at most eight deterministic parts of at most 500 UTF-16 units including labels. It inserts a zero-width separator after `@` to suppress accidental username mentions. Splitting iterates Unicode code points, preserving surrogate pairs. Oversized plans fail explicitly. Discord has a single 2000-unit response with public success, ephemeral errors, and disabled mentions. The providers document character limits without a precise Unicode counting algorithm. The selected conservative bound is no larger in code points than in UTF-16 units. Live Unicode behavior remains unverified.

`bindData`, `bindAccount`, and `bindTenants` separate namespace discovery from runtime clients. `Worker.URL` supplies the deferred actual origin, including in DO construction. A cloud configured origin must match it. Local development requires an explicit validated HTTPS tunnel origin. Test endpoint bindings live under `tests/cloud` and accept only validated synthetic tenant stages. Production has no endpoint override environment variables or control RPC.

The bot adds one direct workspace dependency on `@arctools/arc-data`. `apps/bot/package.json` and its workspace lockfile entry are the only dependency changes. Legacy applications, cache policy and command handlers remain unchanged.

## Local evidence

Final preflight used the cached Linux x64 Bun binary whose `--version` reports `1.3.5`. The resumed host runs Bun 1.4.2 by default and `bunx bun@1.3.5` failed to copy its cached executable, so the pinned binary directory was placed first in `PATH`. `TURBO_FORCE=true bun run test` passed 273 tests and 1239 assertions, including all 243 accepted baseline tests and 30 new ingress, presentation and tenant cases. All six workspace tasks ran without cache hits. `TURBO_FORCE=true bun run build` passed four tasks. `TURBO_FORCE=true bun run check-types` passed seven tasks and root TypeScript. `TURBO_FORCE=true bun run lint` checked 142 files. Logs are `.cloud-tests/unit3-final-{tests,build,types,lint}.log`. A new branded-ID assertion failed typechecking and was corrected before this green preflight. The corrected tenant test file separately passed 16 tests and 116 assertions.

The exact pinned directory is `/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin`. Each command below ran with that directory first in `PATH`:

```sh
TURBO_FORCE=true bun run test
TURBO_FORCE=true bun run build
TURBO_FORCE=true bun run check-types
TURBO_FORCE=true bun run lint
bun test apps/bot/test/tenant.test.ts
bun run scripts/cloud-test.ts tenant
```

The new tests exercise actual raw HttpApi handlers, exact byte signatures, malformed UTF-8, body bounds, freshness, future skew, application/install/member checks, no tenant calls on rejected ingress, pending challenges, failed revocation persistence, personal command recursion prevention, origin validation, immutable admission, generation fencing, account RPC uncertainty, original retries and deadlines, multipart stop behavior, replay capacity, reservations, 1200ms healthy duplicate waiting, interruption and compute timeout. They use Alchemy Bun and Bun expectations.

Local behavior is VERIFIED for those executed cases. Added regressions cover useful Twitch budget after an expired computation lease, shared-cache execution of every command on both transports, fully expired data and schedule rejection, bounded raw-stream timeout, mention suppression, and encoded capacity accounting with outstanding reservations. The inherited canonical foundation, cache and account cases remain in the runner.

## Cloud evidence

Three Unit 3 deployments ran. All three failed and completed independent cleanup. The runner's default selects the tenant suite and retains the explicit foundation, cache and account selections. The final tenant suite includes all 15 accepted canonical cases and 12 ingress/tenant cases. It tracks seven Workers and ten namespaces, including the actual Bot's account, cache and tenant plus a test-only tenant lifecycle Worker. The lifecycle Worker invokes the production tenant and storage implementation, production cache policy, and actual Bot account through a cross-script binding. Its controls are absent from production.

The suite records Worker ingress-to-response and client HTTP elapsed time separately in each disposable stage's `timings.json`. The Worker number starts at the application's first fetch statement and ends when the response Effect is encoded. It excludes the Alchemy bridge's runtime initialization and HTTP write. The client number includes those costs, response transfer and strict helper processing. Signature fixture creation is outside the client HTTP interval. The final suite records the first HTTP request to the newly deployed Bot before health or command requests. Cold cache reads are checked against source-call deltas, warm cache reads against absence of new calls, and response contents and flags are asserted. No percentile, speedup, live-provider or cost claim follows from this sample.

## Remaining gates

Root independent code/comment review, root runtime verification, live Discord privacy and timing, live Twitch delivery and grants after onboarding-token expiry, release/CI configuration, cost and final migration acceptance remain NOT VERIFIED. Native alarm scheduling is not a latency guarantee. Controlled provider timing cannot establish live provider timing or exactly-once message delivery.

## Sources and decisions

Protocol checks use the official [Twitch webhook verification](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [EventSub chat context](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event), [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding), and [Discord message limits](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx). Pinned implementation references are `alchemy/src/Cloudflare/Workers/Worker.ts`, `DurableObjectState.ts` and `DurableObject.ts` in the installed beta.83 package.

Model the Domain selected tagged durable states. Boundary Discipline keeps raw protocol objects and tokens out of Tenant receipts. Make Operations Idempotent keeps deadlines and attempt IDs stable across reconstruction. Prove It Works requires actual cloud paths and teardown evidence. Build the Lever extends the rerunnable canonical suite. The local decision trail is `.cloud-tests/unit3-decisions.tsv`. No root-owned audit or design document is changed.

## First cloud deployment and binding correction

Stage `test-tenant-d7f33821-f1c5b43f32e2` failed during upload, before business tests. Six Workers deployed; the seventh test-only Tenant lifecycle Worker was rejected with `config_references_nonexistent_class` for `TwitchAccount`. The canonical tests did not execute and no latency observation was produced. The runner retained `testResult: 1` and `cleanupResult: 0`. Independent cleanup verified zero Workers and namespaces and absent stage state/output. The control backend remained intact. Its result and run journals remain under `.cloud-tests`; the temporary console log did not survive the session restart.

Source inspection traced the declaration error to passing a deferred `Output` into beta.83's `DurableObject.from`. Its runtime accepts a string or a Worker resource; an Effect yielding a string enters its Worker branch and reads an absent `workerName`. The test fixture now supplies the literal physical name derived from its validated synthetic stage. Its Worker properties also consume the actual Bot name output to retain the deployment dependency. No production adapter or installed dependency is changed. Root TypeScript checking passes after this fixture correction.

Before this deployment, the completed candidate's uncached checks passed again under Bun 1.3.5. The default suite passed 267 tests and 1177 assertions. Build passed four tasks, types passed seven tasks plus root TypeScript, and lint checked 142 files. A late type-only schema import error was caught and corrected before deployment; focused verification then passed all 24 new cases. No green claim is based on that intermediate failed local check.

## Second cloud deployment and runtime registration correction

Stage `test-tenant-d7f33821-49d3440f8d8a` deployed all seven Workers and ten SQLite namespaces. All 15 inherited canonical cases passed, including native account alarms. The full run passed 19 tests, failed five, and executed 311 assertions. The negative-ingress case misused the strict HTTP helper for an expected rejection. The cold useful reply, all-command, and concurrent-duplicate cases returned private data failures. The revocation case durably revoked authorization but failed its final sample-count assertion after earlier cases stopped. Those business failures remain failures. No failed business request was replayed into green.

Source inspection of pinned Alchemy showed that a DO discovered only inside another DO's constructor is absent from the Worker's runtime export map. Both Bot and the test lifecycle Worker now explicitly register `ArcCacheDO` during host initialization. This repairs the missing class registration without changing cache policy or treating platform errors as retryable. The tests now assert source-call deltas and exact native/lost-response output. The controlled sell-query keys include the real handler's `minimal=true`. The lost-completion fixture drops only a successful account response and persists evidence that the drop happened.

The final suite also checks native Discord activation interruption, actual account ambiguity stopping multipart delivery, and the first useful cold HTTP request. Test-only native abort failures remain observable. Local Twitch computation fencing now leaves an expired lease recoverable while its immutable ten-second budget remains useful.

All seven recorded deployment-two timing observations were private data failures, including the supposed slow case. The maximum was 719ms application Worker time and 751.33ms client time. They do not establish useful reply headroom or exercise the controlled slow source. Raw samples and resource/run/result journals remain under `.cloud-tests/test-tenant-d7f33821-49d3440f8d8a`. The temporary console log did not survive the session restart.

The run retained `testResult: 1` and `cleanupResult: 0`. Independent cleanup verified zero Workers and namespaces and absent stage state/output. A cleanup-only retry also verified zero resources. The runner now preserves the original test failure across that retry while reporting successful cleanup. The control backend remains intact.

## Final authorized cloud deployment

The command used the pinned Bun 1.3.5 binary directory first in `PATH`, then `bun run scripts/cloud-test.ts tenant`. Stage `test-tenant-d7f33821-b385fd6e4cef` deployed seven Workers and ten SQLite namespaces from `3a4ac15`. The run passed 23 tests, failed four, and executed 352 assertions across 27 cases. It took 141.02 seconds including deployment and normal destruction. `.cloud-tests/unit3-cloud-3.log` retains the console output. The stage directory retains `run.json`, `resources.json`, `timings.json`, and `result.json`.

VERIFIED in this run are all 15 canonical foundation/cache/account cases, the first useful cold Bot HTTP request, actual Bot account origin and pending challenge, ordinary personal chat, controlled slow/missing/malformed errors, concurrent healthy Discord duplicates, persisted admission and native Tenant alarm recovery across reconstruction, loss of a successful account completion without a second POST, native Discord interruption with token-free terminal state, and account ambiguity stopping later Twitch parts. The account and tenant native alarms both executed. Their scheduling provides no latency guarantee.

Four cases failed and remain failed:

- The no-allocation case expected the namespace API to list the first cold request's existing tenant. It returned zero objects throughout the bounded read-only poll. This aborted the case before its signed negative requests. Whether that API can establish allocation visibility for these SQLite objects is INCONCLUSIVE. Local raw HttpApi signature/context/no-tenant tests pass, but this cloud negative-ingress case is NOT VERIFIED.
- The warm Discord request returned the common private failure after 19ms application ingress time and 69.87ms client time. The preceding cold request returned the correct public result and incremented the expected source key once. The warm source-use assertion did not execute after the response mismatch.
- The all-command case sent the correct `buy` result through Discord and Twitch. The next Discord `loot` request returned the common private failure after 13ms application ingress time and 46.63ms client time. The loop stopped, so all ten commands on both actual cloud routes remain NOT VERIFIED. All ten pass locally through the real shared-cache implementation.
- Revocation durably cleared actual account sender and channel authorization before acknowledgement. The case then failed its final sample-count assertion because earlier failures produced only ten observations rather than twenty.

The fast private failures are real evidence. Their origin is INCONCLUSIVE. This run did not capture the existing `x-arc-command-fallback` response header, so the retained samples cannot distinguish a Worker RPC fallback from a Tenant-committed private failure. No new platform workaround or business retry was added. After the run, the test recorder was extended to retain that token-free header. The no-allocation assertion was moved after its signed requests so an allocation-visibility failure will not prevent those requests from executing on a future authorized run. These diagnostic changes have not run on cloud.

Independent cleanup reported `CLEANUP VERIFIED` with zero Workers and zero DO namespaces, absent stage state entries/output, and the control backend retained. The journal preserves `testResult: 1` and `cleanupResult: 0`. No cleanup retry was required for deployment three.

## Final latency observations

The retained ten HTTP samples include five useful public replies, three expected private source errors, and two unexpected private failures. Each row below has one observation except concurrent replies, which have two. These are raw observations, not percentiles or a forecast of live Discord behavior. Before the run the client host had 16 cores and a load average of 1.80. The controlled slow source was configured for 2500ms and its exact production query counter incremented once. Source-call assertions and complete response/visibility assertions distinguish real work from fast errors.

| Scenario | Application ingress ms | Client elapsed ms | Client budget remaining ms | Result |
| --- | ---: | ---: | ---: | --- |
| First HTTP, cold Worker/tenant/cache | 1245 | 1618.64 | 1381.36 | Correct public reply |
| Cold tenant/cache, initialized Worker | 434 | 465.16 | 2534.84 | Correct public reply |
| Warm tenant/cache attempt | 19 | 69.87 | 2930.13 | Unexpected private failure |
| Command buy | 463 | 493.32 | 2506.68 | Correct public reply |
| Command loot | 13 | 46.63 | 2953.37 | Unexpected private failure |
| Controlled slow source | 2183 | 2245.12 | 754.88 | Expected private source failure |
| Missing source | 592 | 631.69 | 2368.31 | Expected private source failure |
| Malformed source | 419 | 458.03 | 2541.97 | Expected private source failure |
| Concurrent original | 1490 | 1525.90 | 1474.10 | Correct public reply |
| Concurrent duplicate | 1166 | 1429.63 | 1570.37 | Same correct public reply |

The maximum across all ten samples was 2183ms application ingress and 2245.12ms client elapsed, leaving 817ms and 754.88ms of the original three-second budget respectively. Across the five useful public replies, the maxima were 1490ms application ingress and 1618.64ms client elapsed. Those leave 1510ms and 1381.36ms respectively. The maxima came from different requests. No useful warm-reply observation was obtained. The compute2350/RPC2700 margins have not passed the complete cloud acceptance gate. No profiler established a dominant limiter, so these samples support only their observed deadline checks. They establish neither a performance comparison nor live-provider timing, privacy or cost.

## Handoff

Commits `6731049`, `55e012b`, and `3a4ac15` contain the implementation, the cross-script fixture correction, and the cache runtime registration/recovery correction. The final evidence/diagnostic commit follows them. Public Tenant contracts remain `acceptTwitch` and `respondDiscord` with schema-derived token-free receipts. Private recovery runs native alarms. Root code/comment review and independent execution remain open. The unresolved cloud failures block implementation acceptance; resolving them and a new authorized cloud run are root gates.

After the diagnostic-only changes, forced typechecking passed all seven tasks plus root TypeScript and lint passed on 142 files again. Those logs are `.cloud-tests/unit3-handoff-{types,lint}.log`. `git diff --check` passes. No application code changed after the final deployment.
