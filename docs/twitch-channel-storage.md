# Twitch channel storage

[Issue #20](https://github.com/PlagueFPS/arc-tools/issues/20) removes the fixed Twitch channel ceiling. The implementation starts with indexed broadcaster records and direct dispatch access. This first unit retains the 32-channel admission policy.

## Ownership

The environment `TwitchAccount` Durable Object remains the transaction owner. Broadcaster records hold configured membership, public membership, and confirmed subscription receipts. Configured and public membership retain their own login and ordering. A subscription receipt can survive membership removal as a cleanup fact.

The account retains one authoritative sender identity, app credential session, refresh lease, shared sender allowance, and provider cooldown. A send claim must inspect channel eligibility and reserve sender capacity in the same transaction. Independent channel records do not create independent global sender allowances.

Indexed records avoid a cross-object commit between broadcaster authorization and sender capacity. A Durable Object per broadcaster would require a protocol for partial failures across those owners. The current design accepts the shared object's throughput limit while removing dependence on a single membership snapshot.

## First implementation unit

The keyed storage adapter and the complete same-revision dispatch path form one unit. Dispatch preflight, credential maintenance, the send claim, and completion use the relevant records. A same-revision account reconstruction must check shared state without loading every broadcaster.

Setup, reconciliation, operator OAuth, public enrollment, subscription observations, and account status still use the joined directory in this unit. Their existing fences and admission policies remain. These operations need further changes before membership can grow without an application-wide ceiling.

Storage parsing, key layout, transaction boundaries, and native alarm composition belong to the storage adapter. Eligibility, OAuth validation, provider calls, and dispatch outcomes belong to account domain logic. Public account and enrollment responses do not expose storage records or credentials.

## Fresh startup and reauthorization

The indexed adapter ignores the old `account:v1` snapshot. It creates an empty keyed account on first access and then retains that keyed state across reconstruction. It does not import or delete the old snapshot. There is no migration marker or bridge-release requirement.

This is an explicit reset of the old test installation. Stored sender and broadcaster grants, public memberships, subscription ownership receipts, OAuth and enrollment sessions, credentials, send attempts, revocation history, rate reservations, and pending repair work do not carry over. Existing keyed accounts keep their current state.

Environment configuration and deployment secrets still identify the sender, configured channels, and provider applications. Run operator setup and complete sender authorization again. A configured channel can return through setup and broadcaster authorization. A public-only channel needs fresh enrollment after the sender is authorized and signed ingress is ready. The existing backend enrollment endpoints do not depend on a website.

Ignoring local state does not revoke Twitch grants or delete remote EventSub subscriptions. Setup reconciles remote subscriptions and obtains fresh confirmed ownership receipts. A remote list or create conflict cannot replace a receipt. The bot does not resume replies until its required grants and confirmed subscription are ready.

During reconciliation, setup replaces managed remote subscriptions for the current callback and sender when their local ownership receipts are absent. This is the existing repair behavior, separate from empty account initialization.

An older release can still read its old snapshot, but that snapshot does not reflect changes made in the keyed layout. There is no synchronized rollback between the two layouts.

## Remaining units

The rest of issue #20 must complete these changes before removing `maxChannels`:

1. Move broadcaster grants and enrollment state into records accessed by the relevant operation. Preserve session binding, replay protection, and scoped revocation during an exchange.
2. Page configured identity resolution, operator discovery, and status. Persist bounded reconciliation progress across restart and interrupted provider calls.
3. Separate outstanding OAuth, enrollment admission, retained session, and send-work budgets from total installed membership. Retain record limits, TTLs, and abuse controls.
4. Remove the admission ceiling and prove mixed configured/public membership and more than 32 public enrollments.

Provider API limits and the sender's chat allowance still bound throughput after membership scales. A record-size bound or active-work budget must not become another total-membership ceiling.

## Verification contract

Storage tests must cover fresh initialization, ignored old snapshots, rollback after interrupted initialization, repeated reconstruction, and rejection of incomplete or malformed keyed state. Keyed round trips preserve independent membership sources, ordering, subscription-only receipts, and other current account facts.

Dispatch tests must inspect actual storage access. An unrelated malformed broadcaster record must not block same-revision dispatch with cached credentials, credential refresh, refresh failure, or an unauthorized send result. Existing shared-rate, ownership, revocation, replay, and deadline regressions must pass.

Run the root checks in order, then run the affected controlled-provider cloud journeys and verify resource cleanup. Controlled providers establish local policy and native storage behavior. Real Twitch authorization, EventSub delivery, grant survival, and chat replies require separate live-provider proof.

## Retained verification

After removing legacy migration, the implementation passed `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run test`, in that order. The local suite passed 509 tests. The ordered check runner and `git diff --check` exited zero. Logs remain under `/tmp/arc-issue20/resumed-*`.

The full controlled-provider suite passed 28 tests in stage `test-tenant-b52d8014-6d1c3c3597d4`. Cleanup verified zero stage Workers, zero Durable Object namespaces, and absent stage state and output. The journal remains under `.cloud-tests/test-tenant-b52d8014-6d1c3c3597d4/`. The transcript is `/tmp/arc-issue20/remove-legacy-cloud.log`.

These results cover fresh keyed startup with the admission ceiling retained. More than 32 installed channels, bounded resumable reconciliation, and live Twitch journeys remain unverified.
