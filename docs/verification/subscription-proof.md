# Subscription ownership verification

Local implementation follows [the selected confirmed-ID contract](../subscription-ownership-design.md). The two round-2 counterexamples fail before the change and pass after it. This is implementation-owner evidence. Fresh technical review, comment review, independent root runtime verification, and unit 4 acceptance remain pending. The whole application migration is incomplete.

## Checkout and commits

The implementation checkout is `/home/angel/.t3/worktrees/arc-tools/t3-42e6847c`, on branch `t3/subscription-proof-model`. It started at `b45b9fb3229cacc788105bce4187ed94da268e97`. No delegates were used.

The combined revision was imported once, in the requested order. The source checkout `/home/angel/.t3/worktrees/arc-tools/t3-5a5c9834` was read only. The original and local commit pairs are:

```text
9eafa00 -> 0a23217
d53eb81 -> c6b5a1b
d61e66f -> f8ad8b1
212e9cd -> 4f7bd61
6f1a3dd -> a700b6a
fce87a0 -> 5f3807e
6e125d8 -> 85c330b
d4d0c30 -> a7af11b
```

`779755b` commits the two failing regressions before production changes. `bbd479e` implements the confirmed-receipt model and the expanded matrix. No other unit 4 base imports were added.

## Binding proof and eligibility

`TwitchProvider.create` now returns schema-derived `created`, `conflict`, or `unknown` outcomes. Only a 202 body containing exactly one validated subscription produces a receipt. Its ID, chat type, version, broadcaster, sender, webhook transport, callback, and live status must match. Empty IDs, malformed JSON, oversized bodies, extra subscriptions, mismatched fields, and nonlive status produce no receipt. The receipt's fingerprint comes from the provider's captured request configuration. It never comes from the account's current configuration stamp.

The create adapter reads status before consuming a success body. A 409 establishes existence. An explicit 401 remains an account client error, including with a non-JSON body. Other uncertain outcomes return `unknown` without retrying the POST. Body consumption remains bounded at 256 KiB and the request remains bounded at four seconds. The shared HTTP helper and its strict regressions were not changed.

`subscriptionIntents` is deleted. A stored confirmed record contains the exact ID, broadcaster, sender, callback, signing binding, and phase. Lists update status only for matching confirmed IDs and targets. Lists never create binding proof. The account does not replace its subscription map with list results.

`decideChannel` supplies status, reconciliation's decision to preserve a confirmed channel, and dispatch eligibility. Dispatch calls it inside the existing atomic send claim. Readiness requires the current revision, configured broadcaster, current sender, exact callback and binding, live confirmed ID, grants, signed-ingress readiness, and no tombstone. Retained obsolete records remain cleanup metadata. Pending confirmation cannot send.

Setup leases persist owner, expiry, revision, and authorization generation. Claim checks guard identity updates, OAuth allocation, retirement, create decisions, and receipt persistence. Provider calls occur outside transactions. Cleanup records retirement before deleting the exact ID. Deletion remains safe for 204 and 404.

The environment uses a separate Twitch application. An app-token list supplies that application's subscriptions. Managed cleanup checks chat type, version 1, webhook transport, broadcaster and sender condition fields, and callback presence. Exact target preservation additionally compares the sender, callback, broadcaster, and ID. Other EventSub types, versions, and transports remain untouched. Obsolete sender and channel subscriptions belonging to that environment application can be removed.

Each reconcile makes one paginated list traversal and at most one create per missing configured channel. Conflict or uncertainty returns pending. A later setup replaces visible unknown IDs. A lost receipt cannot be recovered from a list. A persisted exact receipt survives reconstruction without another create. Finite delayed mutations and eventual provider visibility allow later manual setup to converge. Lease expiry is never treated as proof that an earlier remote mutation stopped.

## Unit 3 integration contract

The old internal observation was `{ id, broadcasterId, senderId, status }`. The required shape is now `{ id, broadcasterId, senderId, status, binding, callback }`. There is no legacy fallback.

Unit 3 must compute `binding` using `subscriptionBinding` from `apps/bot/src/twitch-binding.ts`, with the actual signing secret, client ID, and callback context used to verify ingress. The helper hashes the same tuple used by account construction and provider receipts. The signing secret remains redacted. An ingress deployment using an older verification context must send that older context, even if account configuration has advanced.

Positive observations update only an existing confirmed exact ID with a matching target. A challenge supplies `webhook_callback_verification_pending`; it cannot establish enabled delivery. A verified enabled observation preserves enabled phase against a stale pending list for the same ID. Unknown signed positives cannot manufacture ownership.

A matching current-binding revocation tombstones its ID even before a create receipt is persisted. It advances authorization generation, fences late completion, and invalidates grants for authorization revocation. Retired positives cannot restore ownership. Revoked record phase also prevents resurrection after its tombstone expires. The existing ten-minute tombstone retention is unchanged.

The private storage shape also changes. `subscriptions[channel]` adds immutable `broadcasterId`; `subscriptionIntents` disappears; `setupLease` adds `revision` and `generation`. Existing unaccepted unit 4 rows with the old shape are not accepted as receipts. No production state migration or compatibility decoder was added. The account remains under the same private storage owner. Provider receipts and persistence rows are not tenant contracts.

## Reproduction evidence

The new regression uses production `makeAccount`, production `makeProvider`, schema-encoded account state, and a local HTTP service with synthetic secrets. The service records the actual secret received by each remote mutation and exact HTTP call counts. These are local policy and adapter checks, not native Durable Object or signed-ingress runtime checks.

The before command at regression commit `779755b` was:

```sh
bunx bun@1.3.5 test apps/bot/test/subscription-proof.test.ts
```

The first failure included this exact received-versus-expected diff. The received fingerprint is C's while the remote secret is B's:

```text
  {
-   "binding": null,
+   "binding": "f5d5fd77f68c99e90a51caf90f9aa4d2f8c2b0dc41499b090c48d40e62eff66a",
    "conflict": 1,
    "delete": 0,
-   "get": 2,
-   "outcome": "rejected",
+   "get": 5,
+   "outcome": "sent",
    "post": 2,
    "secret": "secret-B",
-   "send": 0,
-   "setup": "pending",
+   "send": 1,
+   "setup": "ready",
  }
```

The second failure included:

```text
  {
-   "outcome": "rejected",
+   "outcome": "sent",
    "remote": [
      "secret-A",
    ],
-   "sends": 0,
-   "setup": "repair-required",
+   "sends": 1,
+   "setup": "ready",
  }

 0 pass
 2 fail
 2 expect() calls
Ran 2 tests across 1 file. [433.00ms]
```

The final focused reproduction command is:

```sh
bunx bun@1.3.5 test apps/bot/test/subscription-proof.test.ts -t 'late B creation|completing rotated grants'
```

Its captured output is:

```text
bun test v1.3.5 (1e86cebd)

apps/bot/test/subscription-proof.test.ts:
(pass) late B creation and C conflict cannot claim C ownership; manual repair replaces B [207.48ms]
(pass) completing rotated grants cannot make retained enabled A ready or dispatchable [85.37ms]

 2 pass
 19 filtered out
 0 fail
 5 expect() calls
Ran 2 tests across 1 file. [694.00ms]

```

Full before and after output remains at `/tmp/subscription-proof-before.log` and `/tmp/subscription-proof-after.log` in the implementation environment.

## Bounded call assertions

The delayed-B reproduction asserts remote `secret-B` after C's 409, no stored C proof, pending status, rejection, two total creates, zero deletes, and zero sends. Two further C setups leave one remote subscription with actual `secret-C`, its matching stored fingerprint, three total creates, one delete, one conflict, four total list requests, and zero sends. The second repair call preserves the confirmed ID.

The invisible-conflict case runs three setup turns with one list and one create per turn. Every turn remains pending with no record. The fourth turn creates a valid subscription once visibility and conflict conditions clear.

The two-channel case makes exactly two creates per turn during two conflict turns. Its third turn succeeds with two additional creates. Totals are three lists, six creates, four conflicts, zero deletes, and zero sends.

The lost-receipt case replaces one unknown remote ID with one delete and one create on reconstruction. Another reconstruction preserves the confirmed ID without a create. The C lost-response case first replaces late B, then loses C's receipt after actual mutation. Reconstruction replaces that unknown C ID. Totals are four lists, four creates, two deletes, one conflict, and zero sends.

The strict 202 matrix performs seventeen HTTP POSTs. It accepts one matching receipt and rejects sixteen malformed, oversized, or mismatched responses. The valid receipt's ID identifies the fixture's actual secret. The status/network matrix performs eight POSTs without replay, including a connection closed after remote mutation. Rotation, expired-claim, and revocation cases also assert exact call counts and no sends while unavailable.

## Preserved behavior and test changes

All original 200 tests remain represented in the default run. The existing account suite retains its 28 runtime cases. Its fixture moved into `twitch-account-fixture.ts`, reducing the test file below 1,000 lines. The production account is also below 1,000 lines. The new HTTP fixture is confined to tests.

The old test named `ordinary interrupted subscription creation adopts the durable intended binding` now requires conservative replacement when no receipt survived. It asserts removal of unknown IDs, actual replacement bindings, and no additional create after reconstructing persisted receipts. The repeated-rotation test now expects bounded pending outcomes for uncertain creates instead of provider errors.

The cloud reconstruction case makes the same distinction. It preserves already confirmed IDs with exactly two paginated list requests and no POST. After an interrupted unconfirmed create it requires a new remote ID, exactly one additional delete and create, and a fingerprint from the provider's actual request secret. The cloud fixture computes fingerprints from its received request; it does not stamp arbitrary fixture bindings. Observation callers supply the required verification context.

Credential lease and consumed-alarm recovery, source-generation fencing after 401, setup `/users` 401 invalidation, atomic authorization capacity for 32 broadcasters plus a distinct sender, Discord full localization reads, and default discovery of the strict HTTP regressions remain. Command outputs, accepted cache code, send ledger, original deadlines, ambiguous-POST policy, rate reservations, and retention constants are unchanged by this correction.

## Local verification and open gates

`bunx bun@1.3.5 install --frozen-lockfile` passed with Bun `1.3.5 (1e86cebd)`. The imported baseline passed 200 tests and 774 assertions before the new regressions were added.

The focused account and provider run passed 52 tests and 432 assertions. Its log is `/tmp/subscription-proof-focused-final.log`.

The final forced default run passed 221 tests and 931 assertions. Six workspace test tasks ran with zero cache hits. The eight strict harness tests then ran outside Turbo caching through the unchanged default entrypoint. The full log is `/tmp/subscription-proof-all-tests-final.log`.

`TURBO_FORCE=true bunx bun@1.3.5 run build` passed all four build tasks with zero cache hits. `TURBO_FORCE=true bunx bun@1.3.5 run check-types` passed seven workspace tasks with zero cache hits and root `tsc --noEmit`. A separate root TypeScript invocation also passed, including the controlled cloud fixtures. Logs are `/tmp/subscription-proof-build.log`, `/tmp/subscription-proof-check-types-final.log`, and `/tmp/subscription-proof-root-tsc.log`.

`TURBO_FORCE=true bunx bun@1.3.5 run lint` passed the root Biome task. `git diff --check` passed. No comments or suppressions were added. This scan is not an independent comment review.

An intermediate type check rejected a new test fixture that spread the environment union into a two-channel value. The test now schema-decodes the modified fixture configuration. No casts or weakened schema were used to resolve it.

Model the Domain selected immutable receipt records and typed create outcomes. Make Operations Idempotent selected replacement of unknown remote IDs and preservation of persisted receipts. Fix Root Causes required both production-logic reproductions before the fix. Prove It Works required actual HTTP mutations, binding identities, bounded call assertions, and the complete local suite.

The following gates remain NOT VERIFIED:

- Shared native RPC diagnosis and a passing canonical combined Cloudflare run.
- Native account reconstruction and credential alarm recovery with this revision.
- Unit 3 signed-ingress integration and challenge, notification, replay, and revocation behavior through the real Worker.
- Live Twitch authorization survival, EventSub and chat delivery, and timing.
- Live Discord registration, privacy, and timing.
- Fresh technical and comment reviews, independent root runtime verification, final integration, release configuration, and operating cost.

No canonical cloud suite, duplicate RPC diagnosis, real Twitch or Discord mutation, production deployment, or persistent staging deployment ran during this task.
