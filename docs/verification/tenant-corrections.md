# Tenant correction evidence

The correction passes local gates and the final authorized disposable cloud suite. Root independent technical review, comment review, exact-revision verification, and integration remain pending. This is an implementation handoff, not root acceptance.

This worktree imports the candidate exactly once, in order. `6731049` maps to `b2475ea`, `55e012b` to `613b72f`, `3a4ac15` to `2403d3e`, and `0c5caa6` to `e2e270a`. The base is root `b243f09`. The source checkout and root-owned design and review documents remain unchanged. Root reviews and integrates after acceptance.

## Reproduction before application edits

With the pinned Bun 1.3.5 directory first in `PATH`, `bun test apps/bot/test/tenant-corrections.test.ts apps/bot/test/ingress.test.ts` reports `15 pass`, `10 fail`, and `100 expect() calls`. The retained log is `.cloud-tests/corrections-before.log`.

Three failures reproduce eight abandoned Discord claims blocking fresh admission on a new activation at time zero and on the same activation at 5,000 and 602,999 milliseconds. Two reproduce safe retries requested at 100 or 200 milliseconds and returned at 200 being expired despite the original 10,000-millisecond cutoff. Two reproduce command defects escaping without a terminal response. Two signed HttpApi regressions reproduce private failure when the Tenant clock trails the Worker stamp by 1 or 20 milliseconds. The expired signed control passes.

The tenth failure holds an actual HTTP response through `makeProvider` and the accepted `makeAccount` ledger. Advancing the controlled policy clock by 1,500 milliseconds and recovering produces a second dispatch of the same live attempt. The provider POST is still owned by the first account invocation. This is not a toy dispatch-only reproduction. The live-capacity, deadline-equality, and eight-due-item controls pass before corrections. Eight due items progress through two bounded batches and remove the alarm, so the scheduler is retained.

These are newly reproduced local defects. Exact attribution of historical cloud private failures remains INCONCLUSIVE. The clock reproduction does not establish their cause.

## Correction design

The durable tagged work state remains authoritative. Admission reconciles interrupted or expired Discord computations before capacity checks, retaining replay identity and retention. A trusted receipt may lead the Tenant clock without changing its original stamp or deadline. Safe elapsed retries schedule due-now only while both the requested time and completion remain strictly before cutoff.

For delivery, an activation-local completion signal joins a known live dispatch rather than redispatching it when its durable recovery probe becomes due. The signal lives only for that claimed operation, clears on all exits, and is bounded by the original work deadline. Unknown completion and new activations still recover the exact frozen attempt through the account ledger. The one-second probe remains useful for a crash or lost completion. No arbitrary enlarged delivery lease or account-policy rewrite is proposed. This adds ephemeral ownership to the selected design and must receive root review.

Command defects are handled only around command execution. Cancellation and storage/infrastructure failures must remain observable. No whole-operation defect catch is proposed. Test-only request observation will wrap the actual namespace lookup and RPC boundary and forward to the real Tenant. Namespace API listing is removed as an allocation oracle.

## Gates

The corrected uncached default suite passes 293 tests and 1,407 assertions, preserving all 273 imported cases. Build passes four tasks. Typechecking passes seven workspace tasks plus root TypeScript. Lint checks 144 files. `git diff --check` passes. Each Turbo task bypasses its cache under `TURBO_FORCE=true`. The pinned directory is `/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin`, first in `PATH` for every command and its Turbo children.

The commands are `TURBO_FORCE=true bun run test`, `TURBO_FORCE=true bun run build`, `TURBO_FORCE=true bun run check-types`, and `TURBO_FORCE=true bun run lint`. Logs are `.cloud-tests/corrections-final-tests.log`, `.cloud-tests/corrections-build.log`, `.cloud-tests/corrections-final-types.log`, and `.cloud-tests/corrections-final-lint.log`. Earlier typecheck failures remain in the preflight logs. They caught a possibly absent discriminated result and cancellation branches retaining a typed failure channel. Both were corrected before cloud verification.

The additional real HTTP rate-limit regression returns a safe 429 through production provider and account policy, then advances the controlled clock before the Tenant receives its result. Recovery sends the exact same payload and attempt once, after the safe rejection. Equality with either original cutoff remains expired. Other added controls prove cancellation does not commit a result, a late computation returns the timeout that won storage, and storage or account-dispatch defects still escape the command-only boundary. Source data, cache policy, command handlers, and account policy remain unchanged.

Only the imported Twitch `accepted` state remains as an optional unperformed cleanup. No persisted compatibility migration or speculative performance optimization is added. Discord now returns the actual terminal response that won its commit transaction, including a previously committed timeout. No speedup is claimed.

## Cloud proof preparation

Every actual Bot ingress Tenant call uses `bindTenants`. Its two namespace lookups and RPC operations cross the observer before invoking the actual namespace. Per-request observation exists only in `tests/cloud/bot-composition.ts` under a validated synthetic tenant stage. Personal, production, and other test compositions reject that observer. There is no control route. Rejected HTTP diagnostics retain only an allowlisted token-free observation, including counters. Valid positive requests must report one lookup, one RPC, a committed success, and then a recorded duplicate read from production Tenant storage. The positive control performs no inspection query that creates an object.

The private RPC envelope carries admission clock difference, original cutoff, activation, phase, and a fixed code. Public `Tenants` receipts and results remain unchanged. Production logs use fixed messages and codes without causes, raw headers, URLs, bodies, tokens, or user data. Worker fallback has its own phase and code. A private uncommitted Tenant result is distinct from a committed terminal response.

The suite retains all 15 canonical cloud cases. It adds negative request-local allocation assertions, positive forwarding and stored-response controls, ten exact command results through both actual Bot routes, warm source-count checks, and native recovery while a real provider POST is held past its delivery probe. Timing completeness is a separate case from revocation. Discord timing samples and Twitch acknowledgement/delivery observations are retained separately. Source-count and exact content assertions prevent a fast private error from passing as useful work.

No comparative latency claim is planned. The application number measures the first Bot fetch statement through response encoding. It excludes bridge initialization and HTTP write. The client number includes transfer and strict helper processing, with signature fixture construction outside the timer. Twitch delivery observation also includes bounded fixture polling. The client host has 16 cores and reported load averages 0.62, 0.26, and 0.18 before cloud verification. No profile identifies a dominant limiter, so timings support only observed deadline checks. No percentile, live-provider, privacy, or cost inference follows.

Disposable cloud proof, verified cleanup, and root independent reviews remain pending. Up to two new disposable cloud runs are authorized after local gates. Live-provider timing, privacy, token expiry, operating cost, and final migration acceptance remain separate gates.

## First correction cloud run

Stage `test-tenant-50bfdf94-512bc68522ac` deployed revision `3b74ae0` with seven Workers and ten SQLite namespaces. The pinned command was `bun run scripts/cloud-test.ts tenant`. It passed 26 cases, failed three, and executed 520 assertions across 29 cases in 149.22 seconds. All 15 inherited canonical cases passed. `.cloud-tests/corrections-cloud-1.log` and the stage's `run.json`, `resources.json`, `timings.json`, `twitch-timings.json`, and `result.json` retain the complete run. `testResult` remains 1 and `cleanupResult` is 0. Independent cleanup verified zero Workers, zero namespaces, absent state entries/output, and the retained control backend.

Both actual protocols completed all ten commands with exact useful output and no extra source calls on the Twitch cache hits. Native admission/reconstruction, lost successful account completion without a second POST, healthy Discord duplicates, interruption, ambiguity, and revocation passed. The new native alarm test held a real production-account POST past its persisted delivery probe. Recovery joined the live operation and completed both parts. No unexpected private response or Worker fallback appeared among the 17 recorded Discord samples.

The allocation test failed because its purported future Discord signature returned a committed success. It used a client-relative offset of only 31,000 milliseconds against a server-relative allowance of 30,000 milliseconds. Discord also rounds signature timestamps down to whole seconds. A bounded transport delay can make that control valid by the time the Worker receives it. The run captured committed phase, success code, one lookup/RPC, admission difference, cutoff, and activation. It did not retain the signing timestamp itself, so the exact signed skew of this historical request is not measured retrospectively.

The accepted fixture invoked `sell sensors` before the cold-cache case. Its source count was already one, and the subsequent correct cold-guild result used that cached value without incrementing the source. The cold-cache assertion expected a second fetch and stopped before its warm loop. Timing completeness then correctly failed in its own case. The positive allocation control and later negative requests were not reached. These remain failed gates in this run. No failed business response was retried.

Commit `f32ae19` preserves a new failing reproduction for each protocol. The actual raw HttpApi verification receives a controlled 20-second transport advance. Both old future controls return 200 instead of 401. `bun test apps/bot/test/ingress.test.ts` reports 13 pass, two fail, and 75 assertions before the fixture correction. The corrected helper derives its timestamp from the unchanged production future allowance, the strict fixture's 20-second request bound, and one second for timestamp rounding. The same command then reports 15 pass, zero fail, and 79 assertions. Logs are `.cloud-tests/future-control-{before,after}.log`. The local exact freshness and skew boundary tests remain unchanged.

This is a concrete fixture correction before the second authorized deployment. Production application code is unchanged after `3b74ae0`. The first run retained 14 useful Discord observations, with maxima of 1,674 milliseconds application time and 2,046.135 milliseconds client elapsed. Its three intended private source errors have maxima of 2,370 and 2,437.524 milliseconds. These are raw maxima across those categories, not a comparison or completed warm/allocation acceptance. All ten Twitch command timings are retained with successful exact outputs. The original three failed candidate runs remain read-only and their fast-private historical cause remains INCONCLUSIVE.

After that fixture correction, the complete uncached default suite passes 295 tests and 1,413 assertions. Build passes four tasks, typechecking passes seven tasks plus root TypeScript, and lint checks 144 files. The exact commands are unchanged and use pinned Bun 1.3.5. Logs are `.cloud-tests/corrections-run2-{tests,build,types,lint}.log`. `git diff --check` passes. These checks precede the second and final authorized run.


## Final correction cloud run

Stage `test-tenant-50bfdf94-fc0a32c424fc` deployed `724ec90`. Application code is identical to `3b74ae0`; the intervening commits contain fixture regressions, their correction, and evidence. The pinned command was `bun run scripts/cloud-test.ts tenant`. It passed all 29 cases and 631 assertions in 147.46 seconds, including all 15 inherited canonical cases. Both process exits are zero. The suite used real Cloudflare Workers, SQLite-backed Durable Objects, native alarms, and `Cloudflare.state()`, without local emulation.

VERIFIED in this run are every invalid signature, stale/future signature, malformed/oversized body, rejected Discord application/context/options, invalid Twitch context, and PING allocation control. Every such request asserted zero actual Tenant lookup and RPC. The valid positive control asserted one forwarded lookup/RPC, a committed exact useful response, and then a recorded response read from actual Tenant storage with no source increment. Ordinary chat, unknown commands, and generated reply echoes also recorded zero Tenant operations. Namespace object listing is absent from this oracle.

VERIFIED are the useful first cold HTTP request, one source load for a cold cache key, three exact useful warm responses with unchanged source counts, all ten commands on both actual Bot routes, intended slow/missing/malformed private errors, healthy duplicate waiting, durable admission before acknowledgement, native reconstruction/recovery, loss of a successful account completion with no extra POST, a live account POST crossing the delivery probe and completing both parts, Discord interruption without a later message, multipart ambiguity stopping delivery, durable revocation, and independent timing completeness. No business response was replayed to turn a failure green. No static warmup or artificial waiting was added to useful-path timing.

The 22 Discord observations comprise 19 exact useful public responses and three intended private source errors. Every sample reports a committed Tenant result; none reports Worker fallback. Useful public maxima are 1,534 milliseconds application time and 1,563.366 milliseconds client elapsed, leaving 1,466 and 1,436.634 milliseconds against the respective three-second comparisons. Intended private-error maxima are 2,242 and 2,278.789 milliseconds, leaving 758 and 721.211 milliseconds. These maxima are per category and may come from different requests. They are raw observations, not percentiles or a speedup claim.

The first HTTP cold request took 1,229 milliseconds application time and 1,556.845 milliseconds client elapsed. The three warm samples have maxima of 98 and 140.710 milliseconds. Their exact contents and unchanged source counter establish useful cache hits. Admission clock differences range from -63 to 541 milliseconds across recorded requests. Warm useful requests include -16, -16, and -30 milliseconds. Those are directly observed on this corrected deployment and preserve the original stored cutoff. They do not recover the cause of earlier deployments' private failures.

Ten successful Twitch command observations have maximum acknowledgement times of 347 milliseconds application time and 385.649 milliseconds client elapsed. The maximum client observation through confirmation of the exact provider message is 828.753 milliseconds. Confirmation includes fixture polling and the strict HTTP helper. These synthetic observations do not establish live Twitch arrival time or its three-to-five-second goal. They do not establish Discord client privacy, live-provider timing, grant survival after token expiry, operating cost, or exactly-once external delivery.

The stage journal records seven Workers and ten namespaces. Normal destruction removed seven Workers. The independent cleanup command then found no stack resources, verified absent state entries and output, and queried Cloudflare to verify zero Workers and zero namespaces for the exact stage and recorded IDs. The Cloudflare control backend remains retained. `.cloud-tests/corrections-cloud-2.log` retains `CLEANUP VERIFIED` and zero process exits. The final stage's `run.json`, `resources.json`, `result.json`, `timings.json`, and `twitch-timings.json` remain present. The first failed correction run remains present with `testResult: 1`. Both authorized additional deployments are consumed; no third run was attempted.

### Every recorded Discord observation

All values are milliseconds. Client remaining is 3,000 minus that sample's client elapsed time. The scopes are defined above. Codes are fixed diagnostic classifications, not raw causes.

| Scenario | Result | Application | Client | Client remaining | Admission delta | Code |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| first-http-cold-worker-tenant-cache | public useful | 1229 | 1556.845 | 1443.155 | 363 | success |
| allocation-positive | public useful | 730 | 762.155 | 2237.845 | 541 | success |
| allocation-stored-duplicate | public useful | 23 | 64.938 | 2935.062 | -63 | recorded |
| cold-cache-cold-tenant | public useful | 504 | 543.366 | 2456.634 | 325 | success |
| warm-cache-warm-tenant | public useful | 73 | 112.474 | 2887.526 | -16 | success |
| warm-cache-warm-tenant | public useful | 98 | 140.710 | 2859.290 | -16 | success |
| warm-cache-warm-tenant | public useful | 76 | 119.945 | 2880.055 | -30 | success |
| command-buy | public useful | 432 | 497.946 | 2502.054 | 271 | success |
| command-loot | public useful | 146 | 233.282 | 2766.718 | 8 | success |
| command-craft | public useful | 157 | 190.700 | 2809.300 | 19 | success |
| command-find | public useful | 72 | 104.021 | 2895.979 | 14 | success |
| command-sell | public useful | 70 | 102.480 | 2897.520 | 16 | success |
| command-recycle | public useful | 63 | 95.661 | 2904.339 | 8 | success |
| command-recycleto | public useful | 69 | 102.850 | 2897.150 | 15 | success |
| command-event | public useful | 157 | 201.049 | 2798.951 | 23 | success |
| command-active | public useful | 65 | 101.379 | 2898.621 | 13 | success |
| command-upcoming | public useful | 69 | 107.214 | 2892.786 | 12 | success |
| slow | intended private error | 2242 | 2278.789 | 721.211 | 328 | command-error |
| missing | intended private error | 578 | 613.767 | 2386.233 | 391 | command-error |
| malformed | intended private error | 464 | 510.275 | 2489.725 | 297 | command-error |
| concurrent-original | public useful | 1534 | 1563.366 | 1436.634 | 278 | success |
| concurrent-duplicate | public useful | 1146 | 1464.235 | 1535.765 | 38 | recorded |

### Every successful Twitch command observation

All values are milliseconds. Delivery observation is a client measurement through fixture confirmation, not a provider delivery guarantee.

| Command | Application acknowledgement | Client acknowledgement | Client delivery observation |
| --- | ---: | ---: | ---: |
| buy | 347 | 385.649 | 761.111 |
| loot | 86 | 125.090 | 495.225 |
| craft | 103 | 138.096 | 500.162 |
| find | 95 | 133.472 | 819.219 |
| sell | 90 | 121.218 | 485.892 |
| recycle | 90 | 125.079 | 808.467 |
| recycleto | 112 | 147.516 | 518.782 |
| event | 95 | 126.981 | 496.130 |
| active | 93 | 129.781 | 490.339 |
| upcoming | 98 | 143.668 | 828.753 |

### Every final cloud case

These are whole test-case durations from Bun. They include fixture setup, inspection, reconstruction, intentional waits, and assertions. They are not per-command application latency.

| Case | Result | Whole case ms |
| --- | --- | ---: |
| raw HttpApi preserves every byte before JSON decoding | pass | 259.92 |
| SQLite, KV and alarm changes roll back and survive object reconstruction | pass | 588.49 |
| persisted alarm retries on Cloudflare after an intentional first failure | pass | 3838.56 |
| real cache storage round-trips Options, survives native reconstruction and refreshes only at 24 hours | pass | 3772.54 |
| schema, status and parse failures preserve original data, timestamp and persistent cooldown through the day-seven edge | pass | 6866.77 |
| real schedule storage expires at 60 seconds and rejects stale fallback after source failure and reconstruction | pass | 1706.64 |
| same-key cloud refreshes coalesce, independent keys progress and reset fences a late source completion | pass | 2642.97 |
| real cache keys keep ID, search, response flags and limits separate, including valid empty responses | pass | 3547.53 |
| account native storage binds OAuth identity/client, expiry, replay and config revision | pass | 7178.60 |
| paginated setup preserves confirmed IDs and replaces an interrupted unconfirmed create after reconstruction | pass | 3495.73 |
| real account dispatch separates rejection, ambiguity, deadline equality and interrupted POST | pass | 2197.46 |
| token refresh contention and clock overrun preserve the absolute send cutoff | pass | 2165.55 |
| shared global/channel budgets survive requests and revocation blocks further delivery | pass | 7172.07 |
| native account alarm recovers a reconstructed credential lease without losing its schedule | pass | 11050.94 |
| Discord cloud fixture reconciles the full registry and detects partial or stale releases | pass | 3750.89 |
| the first HTTP request to the new Bot completes a useful cold tenant/cache path within the original budget | pass | 74.04 |
| actual Bot verifies raw signatures, freshness, bounds and Discord context without allocating tenants | pass | 2017.80 |
| actual Bot cold and warm Discord responses use the shared production cache with measured full-path headroom | pass | 1239.63 |
| actual Bot account sees its origin, signed challenge stays pending and ordinary personal chat allocates no channel tenant | pass | 1978.52 |
| all ten commands execute through actual Bot routes, cache and accepted account dispatch on both transports | pass | 11740.61 |
| slow, missing and malformed data return private initial responses with measured headroom and no late reply | pass | 4229.93 |
| concurrent signed Discord duplicates retain the original healthy computation beyond 500ms | pass | 1751.75 |
| native Tenant admission persists a useful alarm before acknowledgement and reconstructs into one delivery | pass | 5942.84 |
| lost tenant account completion reuses the persisted dispatch without a second external POST | pass | 1299.64 |
| native recovery joins a live slow account POST and completes its multipart plan | pass | 2809.46 |
| native Discord interruption commits one private response at the original deadline without a late message | pass | 957.44 |
| actual account ambiguity stops the remaining Twitch parts and replay starts no second POST | pass | 10985.60 |
| verified revocation is durable before acknowledgement and blocks the actual account | pass | 311.98 |
| timing coverage contains every useful command and intended error category | pass | 5.17 |

## Final handoff and deviations

Imports occurred once in the requested order. `c16a3cf` contains the initial failing regressions. `3b74ae0` contains application corrections, diagnostics, observer composition, and expanded verification. `f32ae19` contains the second failing fixture reproduction. `724ec90` contains its correction and prior evidence. The final evidence commit changes only this document. `git diff 724ec90 HEAD -- apps packages tests scripts` must remain empty after that commit. All root-owned design/review documents and the imported `tenant-ingress.md` remain identical to their imported versions.

The concrete selected-design deviation is bounded activation-local ownership for a known live dispatch. At most active work contributes an entry. Every exit clears its entry and signals waiters. The external account operation is bounded by the remaining original work deadline, including credential work. Its provider POST already has the accepted `min(4,000ms, remaining original budget)` timeout. A recovery waiter uses the same absolute cutoff. The durable one-second recovery probe still handles unknown completion, crashed/new activations, and lost successful completions. It does not authorize redispatch of a known live account operation. Neither the memory map nor its signal is durable authority. The ledger, generation, activation, and immutable exact payload still decide recovery. No arbitrary larger lease, object lock, account-policy rewrite, or external exactly-once claim is added.

Model the Domain kept transport-specific durable terminal states and ephemeral completion ownership distinct. Fix Root Causes removed the zero-tolerance cross-clock admission assumption and the erroneous elapsed-safe-retry expiry. Sequence Work into Verifiable Units put both failing reproductions before their corrections. Build the Lever extends the rerunnable canonical suite and its request-local observation. Prove It Works required actual production Bot/Tenant/cache/account paths, source counters, exact outputs, native alarms, and independent teardown. No nested reviewer was spawned under the sole-owner instruction. Root's fresh technical and comment reviews remain required.

No production/persistent staging deployment, real Twitch/Discord mutation, external message, push, or PR occurred. Unit 5 legacy deletion remains later. Live-provider timing, privacy, grant expiry, operating cost, release/CI completion, and overall migration acceptance remain open. Original historical cloud attribution remains INCONCLUSIVE. There are no disposable resources left from either correction run.
