# Authorization boundary correction evidence

The two accepted round-3 failures reproduce with production `makeAccount` and `makeProvider` over real loopback HTTP. Both pass after this correction. This is implementation-owner evidence. Unit 4 and the whole migration remain unaccepted. Reviewer B's separate round-3 work is not cleared by these results.

## Checkout and commit mapping

The owner used `/home/angel/.t3/worktrees/arc-tools/t3-d02f27e1`, starting clean at root `60bbce5`. No delegates were used. The source checkout `/home/angel/.t3/worktrees/arc-tools/t3-42e6847c` at `b96620a` was read only. Each requested commit was imported once, in order, without conflicts or duplicate unit 4 base imports.

```text
9eafa00 -> 8299fdd
d53eb81 -> ec9ec40
d61e66f -> 8da15b3
212e9cd -> 723a00c
6f1a3dd -> 2708132
fce87a0 -> 6a66aca
6e125d8 -> ba9fa23
d4d0c30 -> 80c650b
779755b -> 6568c94
bbd479e -> 42fa277
b96620a -> d5e9a88
```

`f0e4f07` commits the two failing regressions before production edits. `c00f654` contains the correction, expanded regressions, and the precise tombstone assertion updates. This document records the evidence separately.

## Reproductions before the fix

The before command at `f0e4f07` was:

The same suite can be selected at its current package paths.

```sh
bunx bun@1.3.5 test apps/bot/test/authorization-boundary.test.ts
```

It failed both tests with two assertions. The complete output is `/tmp/authorization-boundary-before.log`.

The first test creates a confirmed enabled subscription. The provider then lists that exact ID as `authorization_revoked` and rejects replacement creation with 403. After one setup, a matching current-binding revocation observation, and another setup, both grant flags still report authorized and no authorization links appear. Setup reports pending. The actual subscription totals are three lists, three creates, one delete, and zero sends. This reproduces the accepted cleanup-before-revocation failure.

The second test responds to two production `/users` requests with HTML 401. Both setups return `provider`, credential status stays valid, and the credential generation stays the same. The HTTP fixture observes three token POSTs, comprising one app-token mint and two initial OAuth exchanges. The rejected app credential is reused.

## Revocation transition

`AccountState.revoked[id]` now stores `{ until, reason }`. The reasons are `retired`, `revoked`, and `authorization-revoked`. Cleanup retirement records only retirement. It cannot claim that grant invalidation has already happened.

One private `revokeSubscription` transition owns observation fencing and grant invalidation. Its first revocation advances authorization generation. Authorization loss clears the broadcaster and sender grants. A later authorization-loss observation can upgrade an ordinary revocation once. Repeated observations after that upgrade neither clear fresh OAuth grants nor advance generation. Upgrades and duplicates preserve the original tombstone expiry.

Reconciliation applies authoritative list authorization loss while it still has the exact confirmed ID and target. The remote ID, type, version, transport, broadcaster, sender, and callback must match the confirmed record, and its stored binding must match current configuration. An unknown list record has no signing-binding proof and cannot clear grants. A 403 alone still does not establish grant loss.

The list transition changes authorization generation, so the captured setup claim becomes stale before any subsequent delete or create. That setup returns the existing `AccountError` with code `stale`. The next setup returns usable sender and broadcaster authorization links. Completing those exact links allows a later setup to replace the revoked ID and reach ready.

Signed observations still require the actual current verification binding and callback, sender, configured broadcaster, and revision. The transition accepts the first matching revocation after cleanup retirement and before 202 receipt persistence. It fences late receipts and OAuth completions. Positive observations still require an existing matching confirmed live record and no tombstone. They cannot recreate retired IDs.

The ten-minute retention, replay boundaries, send ledger, deadlines, rate reservations, and OAuth capacity are unchanged. Existing confirmed-ID ownership remains the selected design. No intent ownership, compatibility decoder, production state migration, or operation-history framework was added.

## Shared HTTP status authority

`provider-http.request` now returns non-success status and headers before consuming optional error bodies. JSON 429 remains the exception because Discord synchronization uses its `retry_after` field. Rejected responses cancel their body and abort the fetch without awaiting that optional body. This prevents HTML, malformed, oversized, empty, truncated, or hanging 401 bodies from replacing an explicit rejection with a parse or timeout error.

Twitch create now uses that same shared request helper. Its exact 202 receipt checks and distinct conflict, unknown, and client-rejection outcomes remain. Authenticated users, list, delete, create, validate, and send all receive authoritative 401 outcomes from one HTTP boundary. Mint and exchange 401 responses remain typed provider failures. Account invalidation still uses the generation of the rejected credential.

Success bodies still require bounded JSON parsing and their operation's schema validation. The 256 KiB limit and four-second default timeout remain. The helper introduces no retries. Malformed successful message creation remains ambiguous, and dispatching that same attempt again sends no second POST. Existing Discord JSON 429 retry behavior, rate-limit headers, full localization requests, and release fencing remain verified by the focused suite. Errors contain no request URL, header, token, OAuth code, or response body.

A first cancellation experiment showed that Bun body cancellation alone did not promptly close the fixture's hanging response. Adding fetch abort made the server observe cancellation. The retained regression checks actual closure. A separate raw TCP HTTP fixture sends a 401 header with a declared 10,000-byte body and closes after one byte. Its rejection remains authoritative.

An intermediate typecheck caught a branded broadcaster mismatch between the public observation and private receipt shape. The transition now derives its input from the authoritative private receipt schema. No cast or relaxed public schema was added. An initial new alarm test assumed that stale validation removes the existing bounded recovery alarm. The final assertion instead proves that the rejected credential remains absent; alarm policy is unchanged.

## Regression outcomes

The two new files add 22 cases and 90 assertions. They are discovered by the unchanged default bot test command. The subscription fixture supplies real synthetic HTTP responses, request logs, controlled interleavings, and schema-encoded storage.

The original list-first reproduction now returns stale on the first repair setup and two usable links on the next setup. At that point it has made two lists, one create, zero deletes, and zero sends. After completing those returned links, repeating the old revocation leaves grants intact. The next setup reaches ready with totals of three lists, two creates, one delete, and zero sends.

The retirement-first test proves that a missing remote ID can be tombstoned and deleted before signed authorization loss arrives. Replacement 403 preserves grant flags until that authoritative signed observation. The resulting links are usable. Duplicate revocation after fresh OAuth cannot invalidate them, and a positive observation cannot resurrect the retired record.

Other grant regressions cover a signed revocation during list, an in-flight OAuth validation fenced by list authorization loss, upgrade from ordinary revocation to authorization loss, unknown and old list IDs, old binding and callback context, old sender context, and an unconfirmed revoked list record followed by 403. They assert grant flags, authorization links, actual mutation counts, and ready or rejected outcomes.

The HTML `/users` reproduction now returns `client` twice, reports the credential absent after each rejection, and makes a fourth token POST to acquire a replacement app credential. A concurrent late credential-validation success cannot restore the rejected credential. A delayed old-generation HTML 401 also cannot invalidate a newer generation. Those cases assert token POST counts and status.

The HTTP matrix exercises every authenticated Twitch provider operation with HTML, malformed JSON, oversized, empty, and hanging 401 bodies. It checks exactly one request per operation and appropriately typed mint and exchange errors. Truncated-body and cancellation cases use real local HTTP. JSON 429 retains its body and headers. Invalid successful user schemas remain provider errors while retaining the valid credential. Malformed JSON, invalid send schemas, and oversized successful sends become terminal ambiguous outcomes with exactly one POST for repeated dispatch.

All original 221 cases remain. The only changes to their expectations access tombstone `until` and construct the tagged expired tombstone. The original six corrections, rotation counterexamples, exact 202 proof matrix, revocation before receipt persistence, credential lease and consumed-alarm recovery, 401 validation fencing, 33-state OAuth capacity, ten command outputs, Discord localization checks, and eight strict cloud HTTP helper regressions still run. Cloud fixtures, observability, diagnostic tools, default test discovery, CI, dependency versions, accepted cache code, and command code were not edited by this correction.

## Verification commands and exact results

All commands used pinned Bun `1.3.5 (1e86cebd)`.

- `bunx bun@1.3.5 install --frozen-lockfile` passed. Log `/tmp/authorization-boundary-install.log`.
- `bunx bun@1.3.5 test apps/bot/test/authorization-boundary.test.ts apps/bot/test/provider-http.test.ts` passed 22 tests and 90 assertions. Log `/tmp/authorization-boundary-expanded.log`.
- The focused command below passed 80 tests and 565 assertions. Log `/tmp/authorization-boundary-focused.log`.
- `TURBO_FORCE=true bunx bun@1.3.5 run test` passed 243 tests and 1,021 assertions. Six workspace test tasks had zero cache hits. The eight strict cloud helper cases ran afterward outside Turbo caching. Log `/tmp/authorization-boundary-all-tests.log`.
- `TURBO_FORCE=true bunx bun@1.3.5 run build` passed four tasks with zero cache hits. Log `/tmp/authorization-boundary-build.log`.
- `TURBO_FORCE=true bunx bun@1.3.5 run check-types` passed seven workspace tasks with zero cache hits and root `tsc --noEmit`. Log `/tmp/authorization-boundary-check-types.log`.
- `bunx bun@1.3.5 x tsc --noEmit` passed separately, including the existing controlled cloud fixtures. Log `/tmp/authorization-boundary-root-tsc.log`.
- `TURBO_FORCE=true bunx bun@1.3.5 run lint` passed the root Biome task across 129 files with zero cache hits. Log `/tmp/authorization-boundary-lint.log`.
- `git diff --check` passed. The correction adds no comments, suppressions, SDKs, or dependencies. This owner scan is not an independent comment review.

The same suite can be selected at its current package paths.

```sh
bunx bun@1.3.5 test apps/bot/test/authorization-boundary.test.ts apps/bot/test/provider-http.test.ts apps/bot/test/subscription-proof.test.ts packages/twitch/test/account.test.ts packages/twitch/test/provider.test.ts packages/discord/test/sync.test.ts
```

The default-run assertion total is the sum of the actual per-suite counters, `39 + 11 + 117 + 73 + 119 + 589 + 73 = 1021`. The retained baseline log `/tmp/subscription-proof-all-tests-final.log` totals 931 assertions, including 499 bot assertions. The corrected bot suite totals 589. An intermediate progress message mistakenly added the final counters as 1,121; the captured command output and this evidence use the correct 1,021.

Model the Domain selected tagged retirement reasons. Make Operations Idempotent kept duplicate observations from invalidating fresh grants or extending retention. Boundary Discipline placed status authority in the shared HTTP boundary. Fix Root Causes required production-logic HTTP failures before implementation. Prove It Works required usable returned links, actual request counts, and full uncached verification.

## Unit 3 seam and remaining gates

There is no additional public Unit 3 contract change. Unit 3 must still supply `{ id, broadcasterId, senderId, status, binding, callback }` using the actual verified binding and callback context. There is no fallback to account configuration. The private stored tombstone shape changes; it is not a tenant or ingress contract. Production state migration is unnecessary under the approved design.

The following gates remain NOT VERIFIED by this task:

- Independent root runtime verification and fresh technical and comment reviews of this correction. Reviewer B's separate round-3 review is not resolved here.
- The separate canonical plain-versus-traced six-Worker Cloudflare comparison and its native credential alarm execution on prior `b96620a`. This correction performs no duplicate diagnosis or cloud run.
- A passing canonical combined Cloudflare run and actual native reconstruction and alarm behavior for this correction.
- Unit 3 signed challenge, notification, replay, and revocation integration through the real Worker. These tests call the account's verified-observation port; they do not verify signatures themselves.
- Live Twitch grant survival, EventSub delivery, chat delivery, and timing.
- Live Discord registration, privacy, and timing.
- Final integration and deletion, CI environment configuration, release configuration, operating cost, unit 4 acceptance, and migration acceptance.

No cloud deployment, production mutation, persistent staging deployment, or live Twitch or Discord mutation ran during this correction. Root retains final review and integration ownership.
