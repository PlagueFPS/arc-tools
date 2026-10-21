# Subscription ownership correction

This design corrects the two round-2 subscription findings at combined revision `d4d0c30`. It changes the account's private subscription model and provider creation result. The approved Worker, account, tenant, and cache boundaries remain.

## Caller behavior

Operators continue to call setup and status. Tenants continue to dispatch through the account. Repeating setup preserves confirmed current subscriptions and repairs unknown ones. Completing authorization grants cannot make an old binding ready.

Unit 3 supplies verified subscription observations with the signing binding and callback context actually used for verification. The account compares that evidence with its current target. A current account configuration must not relabel an observation verified by an older ingress deployment.

## Selected shape

Use candidate A's confirmed-ID model. Candidate B explored unresolved history but concluded that it cannot reveal the secret used by a remote subscription. Retaining that history would add state without proving ownership. Both candidates distinguish creation from conflict and require a shared eligibility decision.

Delete `subscriptionIntents`. Retain at most one confirmed ownership record per configured channel, plus bounded retired or revoked ID tombstones. An ownership record binds an exact subscription ID to an immutable broadcaster, sender, callback, signing-binding fingerprint, and observed phase. Remote list entries contain presence and status facts, not signing-binding proof.

The provider returns distinct created, conflict, and unknown outcomes. A created result requires a validated 202 body with exactly one authoritative subscription ID and matching type, version, transport, broadcaster, sender, callback, and status. The binding comes from the exact provider configuration used for that request. A 409 proves existence only. A timeout, unreadable body, or malformed success cannot create ownership. Explicit authorization rejection retains the existing credential-invalidation behavior.

Keep provider receipt types and private storage shapes inside the account implementation. Derive schemas and types without casts. Do not add a general operation-history framework or expose transport response objects to tenants.

## One eligibility decision

Status, dispatch, and reconciliation readiness use one decision over the same facts. Ready requires the configured channel, current revision, current sender, exact callback and signing binding, an enabled confirmed ID, required grants, signed-ingress readiness, and no tombstone. A matching confirmed pending ID remains pending. Old records may remain cleanup facts but cannot authorize a send.

Dispatch evaluates this decision inside the existing durable send-claim transaction. The send ledger, ambiguous-send policy, original deadlines, and shared rate reservations remain unchanged.

## Reconciliation and recovery

1. Claim bounded setup work with its revision, authorization generation, owner, and expiry. Perform provider calls outside transactions.
2. Merge remote status only into exact confirmed IDs whose targets match. Preserve verified enabled status over a stale pending list for the same ID. A list cannot manufacture ownership.
3. Retire unusable, obsolete, revoked, or unknown owned chat subscription IDs before deleting them. Restrict cleanup to this environment application's managed chat-webhook scope. Retry deletion by exact ID through the existing safe 204/404 behavior.
4. Issue at most one create per missing channel per setup call. Persist a created receipt only if its captured setup claim and target remain current and the returned ID is not tombstoned. Never rebuild ownership wholesale from list results.
5. Conflict or uncertainty leaves the channel unconfirmed. A later setup observes and replaces the unknown subscription. Bound work and report pending or repair state rather than running an unbounded create/delete loop.

A crash after remote acceptance but before receipt persistence leaves an unknown remote ID. Replace that ID on repair. A crash after receipt persistence preserves the exact proof across reconstruction. A delayed create from an older binding cannot become current merely because it conflicts with a newer request. Repeated setup converges after finite delayed mutations and eventual provider visibility; lease expiry does not prove remote quiescence.

Positive signed observations update only an already confirmed matching ID and target. A challenge alone cannot mark delivery enabled. Record matching current-binding revocations even if they arrive before creation persistence, so a late receipt cannot resurrect the revoked ID. Positive observations cannot recreate a retired record. Preserve grant invalidation, completion fencing, bounded tombstone retention, and ingress replay limits.

Public enrollment narrows revocation ownership for broadcasters that are neither configured channels nor the sender. Their revocations keep the shared sender grant and global authorization generation. Authorization revocation removes only the affected broadcaster grant. Every public-only revocation records a new persisted revocation sequence for that member and clears the active setup lease. Each intent stores the public revocation sequence at begin. At commit, the callback rejects a resolved broadcaster whose member sequence is newer than the intent. The public sequence never invalidates an unrelated broadcaster's intent or changes the global authorization generation. The lease and tombstone fences prevent an older reconciliation from restoring proof, including a create receipt that arrives after revocation. Other pending enrollment intents and exchanges retain their global generation and can finish. Fresh authorization can repair the affected member without operator OAuth. Existing snapshots default the account sequence, member sequence, and intent sequence to zero.

Configured channels and the sender retain conservative global generation and grant invalidation. A single subscription revocation does not identify which dependent identity lost authorization. Public-only revocations therefore never infer sender authorization loss, even when several arrive. Actual shared sender grant loss still needs operator reauthorization when provider evidence reveals it. Controlled provider tests establish local fencing and send isolation. They do not establish Twitch's revocation ordering, live grant behavior, or deployed webhook delivery.

## Corrections to candidate pseudocode

Candidate B's pseudocode is directional, not implementation. Do not delete an arbitrary subscription selected only by channel. Preserve type, version, transport, sender, and application ownership checks. Do not accept a stored current ID without considering remote observations and the canonical decision. Fence every completion and retirement against its captured claim. Withholding readiness under current ingress uses the existing pending or repair statuses; it does not imply that ingress is missing.

## Verification

Regressions must assert actual remote binding identity and send counts for the delayed-B/create-C/409 race and for an old enabled record after rotation and new-grant completion. Cover malformed 202, conflict without visible list data, crash before receipt persistence, duplicate setup, successive rotations, stale completions, sender/callback changes, verified pending/enabled observations, and revocation before receipt persistence.

Update tests that previously expected adoption from intent to require replacement when no receipt survived. Keep no-create reconstruction expectations for persisted confirmed IDs. Preserve all command fixtures, credential alarm and 401 regressions, OAuth capacity, localization, and strict harness checks. New native or provider tests do not establish cloud success until executed. Shared native RPC diagnosis and a passing combined cloud suite remain separate acceptance gates.
