# Tenant and signed ingress verification

Unit 3 implements the selected Candidate A contract on baseline `d22e51a`. Root owns independent review and integration. No production deployment, persistent staging deployment, live Twitch or Discord mutation, or nested delegation is authorized or performed.

## Contracts and implementation

`ingress.ts` verifies bounded original bytes before JSON decoding. Worker fetch stamps receipt before acquiring clients or constructing routes. Twitch verifies HMAC over ID, timestamp and bytes. Discord verifies Ed25519 over timestamp and bytes. Ingress checks protocol context before calling the tenant. Discord PING has no guild or tenant. The Worker returns a private initial response when a valid Discord tenant RPC fails or exceeds its original budget.

`tenant.ts` exposes `acceptTwitch` and `respondDiscord`. Its private recovery operation also serves native alarms. A schema-encoded snapshot owns identity, immutable deadlines, claims and replay records. Admission stores the first claim and useful alarm before registering immediate work with DO `waitUntil`. Network operations run outside transactions. Generation, activation and lease fencing prevent stale completion. Twitch freezes the complete presentation plan and exact account payload before dispatch. Attempt IDs use immutable work identity and part index. Unknown account completion retains that attempt. Ambiguity stops remaining parts.

Discord computes inline. Duplicates use read-only polling, at most 100 reads spaced at least 25ms, until the original 2350ms compute cutoff. A reconstructed activation commits a private interruption. The Worker bounds RPC at original receipt plus 2700ms. These margins remain hypotheses until measured on cloud. There is no token persistence, defer or later message API.

Capacity is 64 retained records, eight active records, and 120 KiB including outstanding 8 KiB reservations. Only expired records are reclaimed. Terminal Twitch records drop invocation, target and plan. Discord retains a bounded token-free response. No idle tenant alarm is scheduled.

`presentation.ts` preserves complete text within conservative UTF-16 limits. Twitch uses a non-command prefix and at most eight deterministic parts of at most 500 UTF-16 units including labels. Splitting iterates Unicode code points, preserving surrogate pairs. Oversized plans fail explicitly. Discord has a single 2000-unit response with public success, ephemeral errors, and disabled mentions. The providers document character limits without a precise Unicode counting algorithm. The selected conservative bound is no larger in code points than in UTF-16 units. Live Unicode behavior remains unverified.

`bindData`, `bindAccount`, and `bindTenants` separate namespace discovery from runtime clients. `Worker.URL` supplies the deferred actual origin, including in DO construction. A cloud configured origin must match it. Local development requires an explicit validated HTTPS tunnel origin. Test endpoint bindings live under `tests/cloud` and accept only validated synthetic tenant stages. Production has no endpoint override environment variables or control RPC.

The bot adds one direct workspace dependency on `@arctools/arc-data`. `apps/bot/package.json` and its workspace lockfile entry are the only dependency changes. Legacy applications, cache policy and command handlers remain unchanged.

## Local evidence

Initial completed-candidate checks used Bun 1.3.5. `TURBO_FORCE=true bunx bun@1.3.5 run test` passed 267 tests and 1177 assertions, including all 243 accepted baseline tests and 24 new ingress, presentation and tenant cases. All six workspace tasks ran without cache hits. Forced build passed four tasks. Forced typechecking passed seven tasks and root TypeScript. Lint checked 142 files. Later final checks are recorded below when complete.

The new tests exercise actual raw HttpApi handlers, exact byte signatures, malformed UTF-8, body bounds, freshness, future skew, application/install/member checks, no tenant calls on rejected ingress, pending challenges, failed revocation persistence, personal command recursion prevention, origin validation, immutable admission, generation fencing, account RPC uncertainty, original retries and deadlines, multipart stop behavior, replay capacity, reservations, 1200ms healthy duplicate waiting, interruption and compute timeout. They use Alchemy Bun and Bun expectations.

Local behavior is VERIFIED for those executed cases. Native cloud behavior and timing are NOT VERIFIED until the completed candidate's cloud suite executes. The inherited canonical foundation, cache and account cases remain in the runner.

## Cloud evidence

No Unit 3 cloud deployment has run yet. The three-deployment maximum applies to this task. The runner's default now selects the tenant suite and retains the explicit foundation, cache and account selections. The tenant suite includes all 15 accepted canonical cases and nine new cases. It tracks seven Workers and ten namespaces, including the actual Bot's account, cache and tenant plus a test-only tenant lifecycle Worker. The lifecycle Worker invokes the production tenant and storage implementation, production cache policy, and actual Bot account through a cross-script binding. Its controls are absent from production.

The suite records Worker ingress-to-response and client HTTP elapsed time separately in each disposable stage's `timings.json`. The Worker number ends when the response Effect is encoded, before the bridge writes the HTTP response. The client number includes response transfer and strict helper processing. Signature fixture creation is outside the client HTTP interval. Cold cache reads are checked against source-call deltas, warm cache reads against absence of new calls, and response contents and flags are asserted. No percentile or cost claim follows from this sample.

## Remaining gates

Root independent code/comment review, root runtime verification, live Discord privacy and timing, live Twitch delivery and grants after onboarding-token expiry, release/CI configuration, cost and final migration acceptance remain NOT VERIFIED. Native alarm scheduling is not a latency guarantee. Controlled provider timing cannot establish live provider timing or exactly-once message delivery.

## Sources and decisions

Protocol checks use the official [Twitch webhook verification](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [EventSub chat context](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event), [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding), and [Discord message limits](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx). Pinned implementation references are `alchemy/src/Cloudflare/Workers/Worker.ts`, `DurableObjectState.ts` and `DurableObject.ts` in the installed beta.83 package.

Model the Domain selected tagged durable states. Boundary Discipline keeps raw protocol objects and tokens out of Tenant receipts. Make Operations Idempotent keeps deadlines and attempt IDs stable across reconstruction. Prove It Works requires actual cloud paths and teardown evidence. Build the Lever extends the rerunnable canonical suite. The local decision trail is `.cloud-tests/unit3-decisions.tsv`. No root-owned audit or design document is changed.

## First cloud deployment and binding correction

Stage `test-tenant-d7f33821-f1c5b43f32e2` failed during upload, before business tests. Six Workers deployed; the seventh test-only Tenant lifecycle Worker was rejected with `config_references_nonexistent_class` for `TwitchAccount`. The canonical tests did not execute and no latency observation was produced. The runner retained `testResult: 1` and `cleanupResult: 0`. Independent cleanup verified zero Workers and namespaces and absent stage state/output. The control backend remained intact. Console evidence is `/tmp/tenant-cloud-1.log`.

Source inspection traced the declaration error to passing a deferred `Output` into beta.83's `DurableObject.from`. Its runtime accepts a string or a Worker resource; an Effect yielding a string enters its Worker branch and reads an absent `workerName`. The test fixture now supplies the literal physical name derived from its validated synthetic stage. Its Worker properties also consume the actual Bot name output to retain the deployment dependency. No production adapter or installed dependency is changed. Root TypeScript checking passes after this fixture correction.

Before this deployment, the completed candidate's uncached checks passed again under Bun 1.3.5. The default suite passed 267 tests and 1177 assertions. Build passed four tasks, types passed seven tasks plus root TypeScript, and lint checked 142 files. A late type-only schema import error was caught and corrected before deployment; focused verification then passed all 24 new cases. No green claim is based on that intermediate failed local check.
