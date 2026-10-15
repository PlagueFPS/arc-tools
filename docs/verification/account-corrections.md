# Account and release review corrections

This branch starts at root `d8d291b` and cherry-picks unit 4 as `5b5cd91`. The original unit 4 commit is `4988f00b5d3ffe53abff89f6331ff1bb8f82b6dd`. Its checkout was read only. Commit `165a0d6` records failing regressions before the production fixes.

The six findings from independent review A are addressed locally. Unit 4 remains unaccepted pending independent review and runtime checks. Review B findings are outside this report. Signed ingress and tenants remain unit 3. Final wiring and deletion remain unit 5. The full migration is incomplete.

## Ownership and implementation

`makeAccountStorage` synchronizes the persisted intended alarm with `storage.getAlarm()` inside the account transaction. A consumed native alarm can therefore be restored even when the intended timestamp has not changed. Credential recovery schedules an outstanding lease or retry instead of leaving the constructor's immediate timestamp behind.

Session generations now identify the credential across validations. An explicit 401 clears both that session and its outstanding credential claim. A validation completion checks its claim and source session generation before saving. Dispatch also checks the captured credential generation before reserving and starting a POST. Terminal and ambiguous message attempts retain their existing behavior.

Subscription creation persists its binding intent before the provider mutation. Reconciliation adopts an interrupted creation only with matching durable ownership or intent. Rotation removes older or unknown bindings. Final readback also checks binding ownership. Intents survive account reconstruction and configuration replacement and are bounded to the resolved channel set. Initial unknown subscriptions are replaced because the list API cannot reveal their signing secret.

Setup applies the same generation-fenced explicit-401 handling to user resolution and subscription reconciliation. A provider failure without an explicit rejection preserves the session. A late 401 for an older session cannot clear a replacement credential.

OAuth allocation commits the complete batch atomically. Its capacity derives from 32 supported channel identities plus one distinct sender. Repeated setup can replace older links for the same missing roles when capacity is full. Capacity recovery removes expired, stale, or already-granted states as needed. The returned batch remains usable, and personal accounts retain the sender/broadcaster scope union.

Every Discord registration GET, including status-only checks and readback, requests `with_localizations=true`. The local and cloud provider fixtures omit command, option, and choice localization maps unless that query is present.

The Effect service-design choice remains unchanged. The account owns lifecycle and credential policy, the provider owns HTTP, and storage owns atomic record/alarm synchronization. The storage constructor now accepts the narrow storage operations it uses; its production caller supplies native Cloudflare storage. The local alarm model runs that production storage adapter. Model the Domain placed subscription intent before creation. Fix Root Causes kept invalidation at the session/claim boundary. Prove It Works separates the local model results below from the unrun native gate.

## Failing regressions

Run the initial regressions at `165a0d6` with:

```sh
bunx bun@1.3.5 test ./apps/bot/test/twitch-account.test.ts ./apps/bot/test/discord-sync.test.ts
```

The captured result was:

```text
24 pass
6 fail
205 expect() calls
Ran 30 tests across 2 files.
```

Each finding failed for its reported behavior:

1. `recovery schedules the next credential action when an existing session has an unexpired lease` expected `1000000010000` but received `1000000000001`. There were no additional validation calls before the lease expired.
2. `a held validation cannot resurrect a session rejected by a newer send 401` expected credential `absent` after releasing validation but received `valid`.
3. `interrupted subscription bindings survive repeated rotations and reconstruction` expected remote bindings `["binding-d", "binding-d"]` but received `["binding-b", "binding-c"]` even though setup returned ready.
4. `full localization reads detect and remove drift on commands, options and choices` expected drift `true` but received `false` from a provider that hid maps on the default GET.
5. `setup users 401 invalidates the app session and the next setup mints again` expected credential `absent` after the rejection but received `valid`.
6. `32 channels and a distinct sender allocate all links atomically across repeats and expiry` failed with `AccountError` code `capacity` before returning the required 33 links.

Two additional failures were reproduced before correcting their respective mechanisms:

```sh
bunx bun@1.3.5 test ./apps/bot/test/twitch-account.test.ts --test-name-pattern 'a consumed alarm'
```

Restoring only the original timestamp comparison in the production storage adapter produced this result. The fixed file was restored immediately afterward.

```text
Expected: 1000003595000
Received: null
(fail) a consumed alarm is rearmed when a cached credential leaves the intended timestamp unchanged
0 pass
1 fail
2 expect() calls
```

```sh
bunx bun@1.3.5 test ./apps/bot/test/twitch-account.test.ts --test-name-pattern 'capacity recovery'
```

Keeping old already-granted states during capacity recovery produced this result:

```text
_tag: "AccountError",
code: "capacity"
(fail) capacity recovery discards obsolete granted states before allocating newly revoked roles
0 pass
1 fail
33 expect() calls
```

The local capture files are `/tmp/arc-account-corrections-before.log`, `/tmp/arc-account-alarm-equality-before.log`, and `/tmp/arc-account-capacity-recovery-before.log`. They are evidence from this checkout, not cloud journals.

## Passing local verification

All checks used Bun 1.3.5 with Effect 4.0.4 and Alchemy 2.0.0-beta.83. No manifest or dependency changed.

```text
bunx bun@1.3.5 install --frozen-lockfile
484 packages installed. Lockfile unchanged.

bunx bun@1.3.5 test ./apps/bot/test/twitch-account.test.ts ./apps/bot/test/discord-sync.test.ts
34 pass
0 fail
305 expect() calls

bunx bun@1.3.5 test ./packages/utils/test ./packages/arc-data/test ./packages/commands/test ./apps/discord-bot/test ./apps/twitch-bot/test ./apps/bot/test
192 pass
0 fail
701 expect() calls
Ran 192 tests across 24 files.

bunx bun@1.3.5 x turbo run build check-types --force
11 successful tasks. Zero cache hits.

bunx bun@1.3.5 x tsc --noEmit
Exit 0.

bunx bun@1.3.5 run lint
Biome checked 119 files. No fixes or errors.

git diff --check
Exit 0.
```

All 181 original tests and ten command fixtures remain. Eleven added tests cover the six findings, unchanged alarm timestamps, ordinary interrupted subscription adoption, both validation/401 completion orders, replacement-session fencing, ambiguous setup failures, maximum-cardinality link completion, and capacity recovery. Localization coverage checks command and option names/descriptions, choice names, correction, no-op, status-only drift, and localization-only readback failure.

The initial check-types run caught a widened retry outcome type. The next root TypeScript run caught a missing `orDie` at the native fixture's transaction boundary. Both were corrected; neither failure was discarded. An initial maximum-channel reproduction used a login outside the fixture schema and was corrected before capturing the six-defect result above.

## Native cloud gate and remaining evidence

Real Cloudflare execution is NOT VERIFIED on this correction branch. The known foundation/cache harness failures are assigned to the separate harness owner. This branch does not alter that owner's transport, readiness, foundation, or cache files and does not rerun the unchanged failed suite.

`AccountFixtureObject.alarm` now invokes the same `makeAccountRpc(...).alarm` hook used by the production object. Its existing clock remains injected for deterministic account cases. A separate fixture object enables real time, obtains a synthetic provider credential, persists an interrupted credential lease, and reconstructs through native `state.abort`. The new cloud case observes automatic alarm execution, no validation before lease expiry, the next native and persisted times, and validation after expiry. Its snapshot reads storage without invoking status or credential RPCs, so inspection cannot repair a missing alarm. No production fixture controls were added.

The native gate is the test named `native account alarm recovers a reconstructed credential lease without losing its schedule`. The cloud Discord case also checks localized drift and verifies that every GET requested the complete maps. Both compile in the root TypeScript check. They have not been deployed or executed here. The local alarm model reproduces consumption by clearing the modeled native schedule before entering the production account/storage code. It does not establish Cloudflare alarm semantics.

After integrating the separate harness correction, root should run:

```sh
bunx bun@1.3.5 run scripts/cloud-test.ts account
```

Retain the isolated stage's failures and verify cleanup through the existing runner. Native reconstruction across multiple interrupted signing-secret rotations still needs real-cloud review; the deterministic reconstruction/rotation regression and the existing native interrupted-create case are separate evidence.

Cloudflare documents that `getAlarm()` returns null inside a consumed handler unless it is rearmed, and warns that constructor scheduling can interfere with an existing alarm. See [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). Discord documents the full-localization query on [Get global application commands](https://docs.discord.com/developers/interactions/application-commands#get-global-application-commands). These contracts guided the fixture changes; they are not runtime evidence.

No cloud resources or live provider resources were created by this correction run. No production or persistent staging deployment, live Twitch/Discord mutation, push, PR, or merge occurred. Live grants after onboarding-token expiry, signed EventSub delivery/revocation, Twitch delivery timing, Discord privacy/timing and registration, CI/portal configuration, and operating cost remain NOT VERIFIED. Independent review and root runtime acceptance remain required.
