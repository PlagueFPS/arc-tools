# Foundation verification

Status is **VERIFIED for the foundation gates** on 2026-10-15. Independent root review and integration remain pending. This record does not verify the future bot workflows.

The implementation revision is `89db64f9cb7c233fa128653dc291dcd9087dad6a`, on branch `t3/cloudflare-migration-foundation`. The starting revision was `98a7fe7`. The worktree is `/home/angel/.t3/worktrees/arc-tools/t3-f333e23c`. This record is committed separately after the implementation so its revision is unambiguous.

## Scope and implementation

The root `alchemy.run.ts` declares one `arc-tools` stack with `Cloudflare.providers()` and `Cloudflare.state()`. The application Worker exposes only `GET /health`, which returns `{"status":"foundation","stage":"<stage>"}`. It does not claim that bot commands are deployed.

Test stages additionally declare a separate probe Worker and a SQLite Durable Object. Those declarations live under `tests/cloud/` and are included only for a validated test stage. They exercise platform behavior without implementing Tenant, TwitchAccount, or ArcCache placeholders. There are no provider application calls, subscriptions, Discord registrations, guild lists, deferred replies, cache behavior, or bot delivery in this unit.

Workspace exports resolve directly to `src/index.ts` for both types and runtime consumers. Tests and Worker bundling therefore use the same source. Domain package builds still emit declarations and JavaScript through TypeScript. Turbo no longer requires those generated files before source-based tests or typechecking. Biome excludes generated Alchemy bundles and cloud journals.

All 122 preexisting tests were ported. Effect tests use `alchemy/Test/Bun` and Bun expectations. Clock-dependent tests receive a fresh `TestClock.layer()` per test. Pure synchronous tests use `bun:test`. Vitest configuration and installed Vitest dependencies were removed after their callers migrated. The optional Vitest peer metadata inside Alchemy's lockfile entry is upstream metadata, not an installed test runner.

The old apps remain for unit 5 to remove. Their only runtime changes are required Effect v4 API renames. `ServiceMap.Service` became `Context.Service`, Config constructors use the published capitalization, tagged errors use `Schema.TaggedError`, and HTTP imports use `effect/http`. The exported legacy `CommandRuntime` remains until callers migrate. No compatibility API was added.

## Published versions and API evidence

The implementation pins `alchemy@2.0.0-beta.83` and `effect@4.0.4`. The published archives were downloaded and inspected, rather than inferring behavior from peer ranges or beta examples.

- [Alchemy published archive](https://registry.npmjs.org/alchemy/-/alchemy-2.0.0-beta.83.tgz) contains the inspected `src/Test/Bun.ts`, `src/Test/Core.ts`, `src/Cloudflare/Workers/Worker.ts`, `DurableObjectStorage.ts`, `DurableObjectState.ts`, `WorkerBridge.ts`, and `src/Cloudflare/StateStore/` sources.
- [Effect published archive](https://registry.npmjs.org/effect/-/effect-4.0.4.tgz) contains the inspected `Config.ts`, `Context.ts`, `Schema.ts`, `http-api/HttpApiBuilder.ts`, `http/HttpServer.ts`, and `testing/TestClock.ts` sources.
- [Alchemy stack testing documentation](https://alchemy.run/testing/testing-a-stack/) supplies the deploy-once and destroy-after-suite pattern. The published Bun adapter is authoritative where examples differ.

`@effect/platform-bun`, `@effect/platform-node`, and the node-shared override are pinned to `4.0.4`. Without the node-shared override, the resolved newer package failed at runtime with `Export named 'make' not found ... effect/dist/Path.js`. The Worker bridge also imports the Node platform peer even when tests run in Bun. Both peers are installed explicitly. Alchemy's SQL adapter dependencies are pinned through overrides to `4.0.4` as well. The actual cloud run below proves this installed combination.

The Worker properties read `Stack.stage`. The published Worker bridge supplies `Stack` at runtime, but does not supply the standalone `Stage` service. Reading `Stage` in a properties effect produced deployed HTTP 500s. The stack constructor itself can still use `Stage`.

## Environment contract

`ARC_STAGE` must equal the selected Alchemy stage. Local mode cannot select `prod`. `APPLICATION_STAGE` must equal the runtime stage and declares which environment owns the configured provider applications. A profile selects deployment credentials and never selects the Twitch sender.

The binding names are `ARC_STAGE`, `APPLICATION_STAGE`, `ARC_ENVIRONMENT`, `TWITCH_SENDER_KIND`, `TWITCH_SENDER_LOGIN`, `TWITCH_CHANNEL_LOGINS`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `OPERATOR_SECRET`. Channel logins use the Config array encoding, such as a comma-separated environment value. Secrets use `Config.Redacted`.

The schema accepts these combinations.

- `prod` uses `ARC_ENVIRONMENT=production`, `TWITCH_SENDER_KIND=bot`, and a nonempty manual channel set.
- `staging` and `local-<name>` accept either `ARC_ENVIRONMENT=personal` with `TWITCH_SENDER_KIND=personal` and exactly the sender's own channel, or `ARC_ENVIRONMENT=bot` with `TWITCH_SENDER_KIND=bot` and a nonempty configured channel set. Dedicated bot capability includes public enrollment regardless of deployment stage.
- Test stages use `ARC_ENVIRONMENT=test`, a synthetic sender and channel, and fixed synthetic Twitch and Discord application IDs.

Production, staging, and concurrently active live local environments require distinct developer-portal applications. The schema checks their declared application stage; it cannot discover portal ownership or detect an operator falsely labeling copied credentials. Unit 4 must validate actual authorization identities. Twitch IDs remain unresolved until setup. No broadcaster IDs or Discord guild IDs are configured in production source.

The cloud runner removes inherited Twitch, Discord, Turso, ARC, and operator variables from its child environment and supplies synthetic fixtures. It creates a cryptographically unique run suffix, combines it with a worktree hash, and persists each run in its own directory. Concurrent worktrees and runs have separate stages and journals.

`cloudSettings` rejects enabled or unrecognized `ALCHEMY_DEV` and `ALCHEMY_TEST_DEV` values, mismatched `ALCHEMY_STAGE` or `ALCHEMY_TEST_STAGE`, non-test stages, and missing or mismatched run identities. The suite passes an explicit stage and `Cloudflare.state()` to `Test.make`, with no `dev` flag. The local default Alchemy profile authenticated successfully after its normal OAuth refresh. No credential values were printed or committed. No production provider applications were used.

## Baseline

Before edits, `bun install --frozen-lockfile`, `bun run build`, `bun run check-types`, `bun run lint`, and `bun run test` succeeded. Initial Turbo results contained cache hits, so the baseline was repeated with `bunx turbo run build check-types test --force`.

The uncached result was `15 successful, 15 total`, with zero cached tasks. There were 122 passing tests in 18 files. Their distribution was 27 utility tests, 18 arc-data tests, 60 command tests, 12 Discord adapter tests, and five Twitch token-decoding tests.

The command registry and handler outputs remain intact for `buy`, `loot`, `craft`, `find`, `sell`, `recycle`, `recycleto`, `event`, `upcoming`, and `active`. Existing fixtures still cover normalization, ID-first lookup and search fallback, the queen alias, and the inclusive two-hour upcoming window.

Two existing discrepancies are preserved. `selectEvent` matches event names only despite the command's map-search description. It uses an exclusive end boundary, while `activeHandler` uses an inclusive end boundary. This migration does not change either behavior.

## Final local checks

These commands succeeded against the implementation contents. The host Bun version is 1.4.2. The repository and CI remain pinned to Bun 1.3.5, which was also exercised directly.

```text
bun install --frozen-lockfile
Checked 256 installs across 355 packages (no changes)

bun run build
Tasks: 4 successful, 4 total

bun run check-types
Tasks: 7 successful, 7 total
$ turbo run check-types && tsc --noEmit

bun run lint
Checked 92 files. No fixes applied.
Tasks: 1 successful, 1 total

bun run test
Tasks: 6 successful, 6 total
@arctools/utils: 27 pass
@arctools/arc-data: 18 pass
@arctools/commands: 60 pass
@arctools/bot: 6 pass
discord-bot: 12 pass
twitch-bot: 5 pass
```

The direct pinned-runtime command was:

```sh
bunx bun@1.3.5 test ./packages/utils/test ./packages/arc-data/test ./packages/commands/test ./apps/discord-bot/test ./apps/twitch-bot/test ./apps/bot/test
```

Its actual output ended with:

```text
128 pass
0 fail
239 expect() calls
Ran 128 tests across 19 files.
```

The six additional tests check environment combinations, test-stage isolation, tenant partition construction, registry-derived command validation, and configuration binding without provider I/O. `git diff --check` passed. A comparison against locally available credential material found no credential material in changed files.

## Real Cloudflare gate

The successful command was `bunx bun@1.3.5 run scripts/cloud-test.ts`. The child test runner reported `bun test v1.3.5 (1e86cebd)`.

The stage was `test-foundation-9726feb5-7b038691c862`, with run identity `7b038691c862` and deployment profile `default`. Its application Worker was `arc-tools-bot-test-foundation-9726feb5-7b038691c862`. Its test Worker was `arc-tools-probe-test-foundation-9726feb5-7b038691c862`. Its SQLite namespace ID was `1807bf9754304748989315ea0c53380b`.

The suite deploys in `beforeAll(deploy(Stack))` and destroys in `afterAll(destroy(Stack))`. A second setup hook activates the real object, queries the Cloudflare namespace API, asserts `useSqlite=true`, and records the actual Worker names and namespace ID before tests execute.

The actual successful test and teardown output included:

```text
(pass) raw HttpApi preserves every byte before JSON decoding
(pass) SQLite, KV and alarm changes roll back and survive object reconstruction
(pass) persisted alarm retries on Cloudflare after an intentional first failure
Plan: 2 to delete, 1 binding changes
[Bot] deleted
[Probe] deleted
Done: 2 succeeded
3 pass
0 fail
25 expect() calls
Ran 3 tests across 1 file.
CLEANUP VERIFIED test-foundation-9726feb5-7b038691c862: Cloudflare lists 0 Workers and 0 DO namespaces; state entries and output absent; control backend retained
Foundation tests exit 0; cleanup exit 0
```

These assertions establish the required platform facts.

- The deployed application health response contains the selected test stage. The probe's raw HttpApi handler returns exactly the submitted byte array, including NUL, invalid UTF-8, CRLF, JSON-looking bytes, and trailing whitespace. No JSON decoder runs before that read.
- A committed SQLite row survives a transaction that changes SQL, KV, and the alarm and then fails with the exact intentional rollback error. The original row value, absent KV change, and original alarm timestamp remain after rollback.
- The fixture flushes storage and calls the native object abort operation. A later request sees a different per-construction UUID, the same committed row, and the same persisted alarm. This is actual reconstruction, not a new local JavaScript object standing in for Cloudflare.
- An armed alarm survives another reset. The first alarm persists its attempt and intentionally fails. Cloudflare retries it. The test reads exactly two attempts, native retry count one, completed work, and no pending alarm.
- Cleanup checks the Cloudflare Workers list and the Durable Objects namespace list. It matches both script names and the previously recorded namespace ID. It also checks that the test stage has no resource rows or stack output in the cloud state store.

Cleanup was separately rerun with `bunx bun@1.3.5 run scripts/cloud-test.ts cleanup test-foundation-9726feb5-7b038691c862`. It again reported no resources, zero Workers, zero namespaces, and cleanup exit zero.

## Failed attempts and recovery

All stage names below have the prefix `test-foundation-9726feb5-`. The failures were retained as failed evidence, then corrected. No local emulation was substituted.

- `51fd7a96edbb` stopped at module import because the Node platform peer was missing. No deploy began. The first cleanup command had the same import failure.
- `5c10c33ad3f2` incorrectly forced the CI credential path locally and reported missing `CLOUDFLARE_ACCOUNT_ID`. No deploy began. The runner now preserves the caller's CI setting.
- `d8a5fb7f8d65` failed Worker bundling because the entry modules lacked their required default exports. The adapter destroyed both planned resources and the final cleanup reported no state rows.
- `79ff6cd4bb8e` passed all three cloud tests under Bun 1.4.2 and destroyed both Workers. This earlier success predates the stronger namespace-ID cleanup check and is not the final acceptance run.
- `32e968db2afa` and `2836f18ca51b` deployed but failed after Worker properties requested the runtime-unavailable `Stage` service. Both were destroyed. The direct API cleanup found zero Workers and namespaces.
- `30bd874f65f1` passed raw HTTP and rollback/reconstruction, then encountered a transient 404 during an alarm snapshot read. It was destroyed and API cleanup passed. Snapshot GETs now use bounded readiness retries.
- `2ef192e69fee` passed raw HTTP but encountered a first-activation failure before the object proof. It was destroyed and its recorded namespace ID disappeared. The suite now activates the object with bounded GET retries before mutation tests. This is fixture readiness, not evidence that a future cold Discord command meets its deadline.
- `7b038691c862` passed all gates under Bun 1.3.5 and passed both initial and repeated API cleanup checks.

The four earliest stages were also recovered with the final cleanup command under Bun 1.3.5. Each returned cleanup exit zero and direct API counts of zero Workers and zero namespaces. This includes both early attempts whose original cleanup commands could not load or authenticate.

## CI and cleanup recovery

Default CI retains install, build, typecheck, lint, and pure tests, then runs the real-cloud suite. An `always()` step retries cleanup for the exact stage emitted through `GITHUB_OUTPUT`. Recovery JSON is uploaded even if tests fail. The runner also attempts cleanup in `finally` and records test and cleanup exit codes separately.

GitHub must supply variable `CLOUDFLARE_TEST_ACCOUNT_ID` and secret `CLOUDFLARE_TEST_API_TOKEN`, mapped to provider variables `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The account needs Workers and Durable Object management plus the permissions required by the existing Alchemy cloud state backend. The state backend must be provisioned separately. The pinned provider's missing-backend guidance names `alchemy provider cloudflare bootstrap --profile <your-ci-profile>`.

No GitHub workflow was triggered and no remote secrets were configured in this unit. Those remote settings remain for the operator. Missing CI credentials or state infrastructure fail the suite; there is no skip or local fallback.

Local recovery data is under `.cloud-tests/<stage>/run.json`, `resources.json`, and `result.json`. The files contain stage/profile/run identities, disposable resource IDs, and result codes, without credentials or URLs. Retry with `bun run test:cloud:cleanup <exact-stage>`. After a hard interruption, restore the matching recovery artifact before running cleanup. Cloud-backed resource state remains available if cleanup fails. Cleanup never destroys the account's Alchemy state backend.

## Contracts for units 2 through 4

Unit 2 inherits source-based package exports, the existing arc-data schemas, local HttpClient test Layers, and all 60 command fixtures. `budgets.metadataFreshMs` is 24 hours, `metadataFallbackMs` is seven days from successful validation, and `scheduleFreshMs` is 60 seconds. These are policy inputs, not implemented caching. Unit 2 owns the schema-derived resource query and cache provenance contracts and the private ArcCache adapter. It must not introduce a generic unchecked `get<T>`.

Unit 3 inherits `TenantKey`, `tenantName`, branded `BroadcasterId`, `GuildId`, `WorkId`, and `Deadline`, plus `CommandName` derived from the registry and schema-derived `CommandInput`. The tenant name is `twitch:<resolved-broadcaster-id>` or `discord:<verified-interaction-guild-id>`. The raw HttpApi mechanism is proven by the fixture; signature verification and ingress admission are not implemented. `budgets.discordInitialResponseMs` is 3000. The selected contract remains HTTP 200/type 4, public success, ephemeral error, and no unconditional defer or guild enrollment.

Unit 4 inherits branded `AttemptId`, `budgets.twitchSendCutoffMs=10000`, and the schema-validated runtime identities and redacted credential bindings. Setup resolves configured logins to IDs and must validate grants against the expected sender. Dedicated production and personal nonproduction identities remain separate. Unit 4 owns TwitchAccount, operator setup/status, external API doubles reachable from Workers, registration reconciliation, and release wiring. The fixture's alarm retry is not a Twitch send-attempt ledger.

All future integration tests must continue using unique real-cloud stages, synthetic application credentials, reachable deterministic provider doubles, recorded resource identities, and verified teardown. Actual Twitch/Discord authorization, delivery, privacy, direct-response timing, token expiry, cache policy, and free-tier usage remain **NOT VERIFIED** and belong to later units.

## Reviewer decisions and deviations

The approved request for `Cloudflare.state()` is implemented literally. The plan's description of that pinned backend as R2 does not match the published beta.83 source. Its `StateStore/Store.ts` implements an encrypted SQLite Durable Object behind a separate Worker and Secrets Store. No R2 backend was invented. The existing backend was retained throughout cleanup. Root should correct that planning assumption separately if needed.

The service-design choice is to use the existing Effect Config capability rather than introduce an application configuration service with no additional authority. Production wiring resolves Config during construction, while the fixture's SQL and alarm I/O occurs inside the inner runtime effect. Model the Domain and Type System Discipline shaped the environment union and branded IDs. Test Behavior, Not Implementation shaped the byte, persisted-state, and retry assertions. Prove It Works required real resource deployment and API readback. Fix Root Causes and Attack the Premise led to inspecting the Worker bridge's available runtime services after the naming regression.

No delegates were spawned. No push, PR, merge, production deployment, or persistent staging deployment was performed. Hooks were not disabled for commits. The root-owned audit log and approved plan were not edited.

## Exact changed paths

The following inventory comes from `git show --format= --name-status 89db64f9cb7c233fa128653dc291dcd9087dad6a`. This record adds `docs/verification/foundation.md` in its own documentation commit.

```text
M	.github/workflows/ci.yml
M	.gitignore
M	AGENTS.md
A	alchemy.run.ts
A	apps/bot/package.json
A	apps/bot/src/api.ts
A	apps/bot/src/config.ts
A	apps/bot/src/contracts.ts
A	apps/bot/src/worker.ts
A	apps/bot/test/config.test.ts
A	apps/bot/tsconfig.json
M	apps/discord-bot/package.json
M	apps/discord-bot/src/events.ts
M	apps/discord-bot/src/index.ts
M	apps/discord-bot/test/events.test.ts
M	apps/discord-bot/test/slash-adapter.test.ts
D	apps/discord-bot/vitest.config.ts
M	apps/twitch-bot/package.json
M	apps/twitch-bot/src/services/auth.ts
M	apps/twitch-bot/src/services/db.ts
M	apps/twitch-bot/src/twitch-commands.ts
M	apps/twitch-bot/test/auth.test.ts
D	apps/twitch-bot/vitest.config.ts
M	biome.json
M	bun.lock
M	package.json
M	packages/arc-data/package.json
M	packages/arc-data/src/arc.ts
M	packages/arc-data/src/events.ts
M	packages/arc-data/src/items.ts
M	packages/arc-data/src/traders.ts
M	packages/arc-data/src/utils.ts
M	packages/arc-data/test/events.test.ts
M	packages/arc-data/test/fetch-contract.test.ts
M	packages/arc-data/test/schema.test.ts
D	packages/arc-data/vitest.config.ts
M	packages/commands/package.json
M	packages/commands/src/lib/command-error.ts
M	packages/commands/src/lib/layers.ts
M	packages/commands/src/lib/runtime.ts
M	packages/commands/test/handlers/active.test.ts
M	packages/commands/test/handlers/buy.test.ts
M	packages/commands/test/handlers/craft.test.ts
M	packages/commands/test/handlers/event.test.ts
M	packages/commands/test/handlers/find.test.ts
M	packages/commands/test/handlers/loot.test.ts
M	packages/commands/test/handlers/recycle-to.test.ts
M	packages/commands/test/handlers/recycle.test.ts
M	packages/commands/test/handlers/resolve-item.test.ts
M	packages/commands/test/handlers/sell.test.ts
M	packages/commands/test/handlers/upcoming.test.ts
M	packages/commands/test/utils.ts
D	packages/commands/vitest.config.ts
M	packages/testing/package.json
M	packages/testing/src/index.ts
M	packages/utils/package.json
M	packages/utils/test/index.test.ts
D	packages/utils/vitest.config.ts
A	scripts/cloud-cleanup.ts
A	scripts/cloud-settings.ts
A	scripts/cloud-test.ts
A	tests/cloud/foundation.test.ts
A	tests/cloud/probe.ts
A	tsconfig.json
M	turbo.json
D	vitest.setup.ts
D	vitest.shared.ts

```
