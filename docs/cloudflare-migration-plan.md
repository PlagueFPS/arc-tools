# ARC Tools Cloudflare migration plan

Status is implementation accepted and integrated. All five units pass their reviewed implementation and executed controlled-provider gates. See the [final root review](verification/final-integration-root-review.md) for the integrated checks, retained failures, and remaining live-provider gates. The design and sequencing below retain the approved planning record. Root orchestrated and reviewed; delegated workers implemented. Production deployment remains outside this approval.

## User and operator experience

Twitch users keep the existing ten `!` commands. Discord guild users use the corresponding slash commands, with public successful results and ephemeral errors. Discord prefix commands and DMs are removed permanently.

Operators deploy one Alchemy stack per environment, authorize that environment's Twitch sender, configure its Twitch channels, and inspect status through a command. Discord administrators install or remove the application through Discord. There is no Discord guild allowlist, enrollment command, or per-guild registration. Objects are addressed lazily using the guild ID supplied by a verified interaction. There is no dashboard, Twitch self-service onboarding, or alerting service in this release. Nothing depends on the old deployment, so replacement needs no compatibility APIs, data import, or staged production rollout.

Proposed operator commands are stage-specific development/deployment scripts, `bun run ops setup`, and `bun run ops status`. Setup returns Twitch authorization links when grants are missing and reconciles that environment's Twitch subscriptions. Discord global registration is automated after deployment from the shared registry. Rerunning setup adopts existing matching resources instead of creating duplicates. No game-data refresh command is added.

Twitch reply completion targets three to five seconds. No new Twitch message-send attempt starts at or after ten seconds from first ingress receipt. Retries never extend that deadline. Discord's baseline is a direct HTTP response before its three-second initial-response deadline, including signature checks, object activation, cache access, and computation. No unconditional defer or background Discord reply workflow is planned. Cold or unavailable data must return a friendly ephemeral failure within the response budget. If testing shows that useful responses cannot fit, revisit deferral before implementation continues. These are acceptance targets, not measured results or guarantees of provider arrival time. Safe retries are preferred to missing a reply. Ambiguous external message creation is never blindly retried.

Launch traffic is a few quiet channels and guilds. Free-tier usage is the target. The spending-ceiling decision is deferred, and no dollar ceiling is agreed.

## Deployment and package boundaries

One root `alchemy.run.ts` declares the Cloudflare providers, deployment-state backend, Worker, secrets, and SQLite-backed Durable Object namespaces. Resource paths are anchored to the declaring file. Construction creates infrastructure and handlers. HTTP calls, database reads, OAuth work, and bot setup run at runtime, not during planning. This follows the [Alchemy Single Stack example](https://alchemy.run/project-structure/monorepo-single-stack/) and [Effect HttpApi integration](https://alchemy.run/cloudflare/apis/effect-http-api/).

Keep Bun, Turborepo, Biome, and TypeScript. Migrate tests to Alchemy's Effect-aware Bun API. The user's explicit testing preference supersedes the current Vitest tooling choice. The intended module map is:

| Location | Owns |
| --- | --- |
| `alchemy.run.ts` | One stack and its resource wiring. |
| `apps/bot/src/config.ts` | Schema-validated environment configuration, Twitch sender and channel logins, and application identities. No source-coded broadcaster IDs or guild allowlist. |
| `apps/bot/src/worker.ts` and `api.ts` | HttpApi routes, raw signature verification, routing, and HTTP responses. |
| `apps/bot/src/tenant.ts` | Tenant Durable Object admission, command execution, delivery state, and recovery. |
| `apps/bot/src/twitch.ts` | Twitch account Durable Object, app credentials, grants, subscriptions, shared send limits, and send-attempt ledger. |
| `apps/bot/src/discord.ts` | Discord protocol adapter, command registration, and response operations. |
| `apps/bot/src/operator.ts`, `scripts/ops.ts`, and `scripts/sync-discord-commands.ts` | Authenticated Twitch setup/status and the deployment-time Discord registration client. |
| `packages/commands` | One command registry, existing handlers, and domain execution. |
| `packages/arc-data` | Upstream schemas, typed data service, and private ArcCache Durable Object adapter. |

These are proposed boundaries, not files already implemented. Keep utilities and testing packages where they remain useful. Domain packages do not import Discord.js, Twurple, Worker request objects, provider tokens, or storage rows.

Start verification with exact published versions `alchemy@2.0.0-beta.83` and `effect@4.0.4`. Use `alchemy/Test/Bun` and `bun:test` expectations. The published Alchemy package contains that adapter; `@effect/vitest` is optional and is not needed for the Bun path. Remove Vitest and `@effect/vitest` after migrating their callers. Published compatibility does not prove runtime behavior. Resolve one workspace export strategy so Worker bundling and tests cannot silently import stale `dist` artifacts. [Alchemy metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.83), [Alchemy Bun testing](https://alchemy.run/testing/testing-a-stack/).

## Environment flow

Alchemy stage selects the stack instance and its resource/state namespace. A profile selects cloud-provider deployment credentials, not the Twitch identity. Runtime Effect Config bindings select the sender, channels, application credentials, and signing secrets. Resolve bindings during construction so Alchemy discovers them, then use them at runtime. CI uses provider environment credentials rather than local profiles. [Stages](https://alchemy.run/environments/stages/), [profiles](https://alchemy.run/environments/profiles/), [config binding](https://alchemy.run/environments/secrets/).

| Environment | Placement | Twitch sender | Subscribed channels |
| --- | --- | --- | --- |
| Automated integration-test stage unique to its worktree/run | Real Cloudflare resources and `Cloudflare.state()`. Destroy the test stack after each run. | Synthetic identity and controlled API services by default. | Synthetic fixtures; separately selected live-provider checks use the personal channel. |
| Local interactive development stage | Local workerd. Live webhooks require an HTTPS tunnel. | Personal Twitch account. | Personal channel only. |
| `staging` | Separate cloud stack. | Personal Twitch account. | Personal channel only. |
| `prod` | Production cloud stack. | Dedicated bot Twitch account. | Environment-configured manual channel set. |

Declare environment values such as `TWITCH_SENDER_LOGIN`, `TWITCH_CHANNEL_LOGINS`, `TWITCH_CLIENT_ID`, and redacted client/signing secrets. Twitch setup resolves logins to stable user IDs and stores them in that stage's account state. EventSub still requires IDs internally, but operators do not hardcode them in source. Validate OAuth-returned identities against the resolved expected account. Production and personal identities never share grant or token state. Missing or inconsistent configuration fails rather than falling back to production values.

Separate applications registered in the Twitch and Discord developer portals are agreed for independently active live environments. Stages alone do not isolate a Discord application's single interactions endpoint or global command registry. Give production, staging, and concurrently active live local testing distinct application credentials. Twitch test applications can authorize the same personal sender while retaining separate subscription ownership. Automated Cloudflare integration tests use controlled provider services by default and need no live provider application; explicitly selected Twitch/Discord checks use nonproduction applications.

Do not run local mode against the production stage. Alchemy documents local/live replacement when the same stage is reused. Test stages never load production application credentials or select production resource/state namespaces. Cloudflare deployment profiles are optional account separation; per-stage resource, runtime-secret, and external-application isolation are still required.

## Discord registration and drift

Register global commands once per environment's Discord application. Derive the complete desired payload from the existing command registry, including guild installation and guild-only interaction contexts. Installation grants availability to guilds without maintaining guild IDs. Signed ingress also checks the application ID and rejects DM contexts. [Discord application commands](https://docs.discord.com/developers/interactions/application-commands).

Recommended GitHub Actions ordering is test/build, deploy the selected stage, wait for that revision's health endpoint, synchronize global commands, and verify the remote definition. Use the same commit and command manifest for deployment and registration. Expose a non-secret build ID and canonical command hash so the registration job verifies it is syncing the deployed revision.

Fetch current global commands, compare owned fields after normalizing Discord-generated IDs, versions, and defaults, and skip unchanged registration. On drift, bulk overwrite the complete application command set. Then fetch again and fail the workflow if normalized fields differ. This owns the application's full command set and removes commands deleted from source. Respect registration rate limits and serialize release/sync jobs per target application. A stale run must not register commands against a newer deployed revision. [Bulk overwrite endpoint](https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-global-application-commands).

There is no atomic transaction covering Cloudflare deployment and Discord registration. The workflow detects and repairs drift at each release and reports a registration failure separately from deployment success. Discord client propagation may lag API verification. Status can perform an explicit drift check; no scheduled polling is added. Tests check payload derivation and reconciliation against controlled Discord APIs; selected live-provider checks verify nonproduction registration without touching the production application.

## Alchemy Bun testing

Use `Test.make` from `alchemy/Test/Bun`, with Cloudflare providers, `state: Cloudflare.state()`, and a unique integration-test stage. Omit the `dev` flag so the suite deploys real Cloudflare resources. `beforeAll(deploy(Stack))` deploys one test stack; tests drive its cloud Worker URL; `afterAll(destroy(Stack))` destroys it after each run, including failed runs. Share one fixture within the suite without letting parallel suites or worktrees share mutable test state. Pure Effect-aware unit tests remain local and do not deploy infrastructure. [Testing a Stack](https://alchemy.run/testing/testing-a-stack/).

In the selected published package, the test harness uses explicit stage options or `ALCHEMY_TEST_STAGE`, independently of CLI `ALCHEMY_STAGE`. Its `ALCHEMY_DEV` and `ALCHEMY_TEST_DEV` settings can select local mode even when the flag is omitted. Validate effective settings so integration CI actually uses cloud providers. Use a distinct stage per run and a dedicated test-state namespace in the Cloudflare-backed store. The pinned `Cloudflare.state()` implementation uses a separate SQLite Durable Object backend with a Worker and Secrets Store. That backend is durable control infrastructure, separate from the disposable application stack. Preserve enough state to retry interrupted or failed teardown. CI makes a final cleanup attempt even when tests fail and reports leftover resources as a failed cleanup result. Cleanup can fail during interruption or provider outages; it is verified rather than assumed. [Harness options](https://alchemy.run/testing/test-harness/).

Cloudflare integration tests exercise real Workers, bindings, SQLite-backed Durable Objects, alarms, storage, and deployment behavior. Use controlled Twitch, Discord, and Metaforge services reachable from those cloud Workers for deterministic failure and retry cases. These are external API doubles, not Cloudflare emulation. Signed webhook fixtures still cross the real cloud Worker boundary. Separate live-provider checks exercise actual personal-account authorization, EventSub delivery, Discord registration/privacy, and timing. Passing cloud integration tests increases production confidence but does not replace those provider-specific checks. Local interactive development may still use workerd and an HTTPS tunnel; it is no longer the integration acceptance environment.

## State ownership

Use three Durable Object classes, with no additional application database:

| Object | Identity | Durable responsibility |
| --- | --- | --- |
| Tenant | `twitch:<resolved-broadcaster-id>` or `discord:<interaction-guild-id>`, within its stage | Command admission, deduplication, deadline, execution state, and direct Discord response. |
| TwitchAccount | One configured Twitch application and sender, within its stage | App-token session, resolved identities, OAuth setup state, subscription status, shared rate reservations, and Twitch send attempts. |
| ArcCache | One cache per stage | Canonical request keys, validated source values, refresh ownership, freshness, and diagnostic status. |

The tenant does not refresh shared credentials. The account does not own command computation. The cache does not own command delivery. Discord registration uses static secrets and needs no separate account object.

Environment-based Twitch channel configuration is authoritative. Objects store resolved IDs and operational facts, not a second independently editable channel list. Discord guild IDs come from signed interactions and require no configured list. Operator Twitch setup is authenticated with a secret bearer credential. A future dashboard can replace the Twitch configuration source and call the same domain operations, without adding dashboard code now.

## Proposed domain contracts

Effect Schemas define and infer boundary types. Brand broadcaster IDs, guild IDs, work IDs, attempt IDs, and deadlines. Do not make these interchangeable strings.

| Contract | Input and result |
| --- | --- |
| Tenant admission | A validated Twitch or Discord receipt with matching environment and tenant. Twitch returns its admission disposition; Discord computes and returns the initial response within its shorter budget. |
| Command execution | Registry-derived command name, normalized input, and deadline. Returns reply text with any stale-data indication, or a domain error. |
| Data reads | A schema-derived resource query. Returns validated data and fresh or fallback provenance. No unconstrained generic `get<T>` API. |
| Twitch dispatch | Stable attempt ID, channel, reply text, and deadline. Returns sent, explicitly rejected, retryable, ambiguous, or expired. |
| Operator operations | Configured environment and Twitch identity, or a status request. Returns Twitch setup progress, command drift information, or redacted status. No guild enrollment operation. |

Private work state is a tagged union with accepted, computing, ready, and terminal variants. Twitch additionally has delivering states for remote message creation, with sent, failed, ambiguous, and expired outcomes. Discord stores deduplication and a bounded response result; interaction tokens are not required in durable storage for direct replies. A terminal transition means every required operation has completed or stopped. Do not carry deferred-followup states into the direct-response baseline.

## Signed ingress and acknowledgement

Stamp receipt time before reading the body. Bound body size and validate route and method. Signed endpoints use raw HttpApi handlers. Verify the original bytes before JSON decoding. Twitch signs message ID, timestamp, and body with HMAC-SHA256. Discord signs timestamp and body with Ed25519. Signature checks, timestamp freshness, and replay retention belong at this boundary. [Twitch verification](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [Discord interaction security](https://docs.discord.com/developers/interactions/overview).

After verification, decode consumed fields and enforce the environment's configured Twitch channels. Ignore ordinary Twitch chat and unknown commands before allocating tenant work. Production can ignore the dedicated sender's own messages. Nonproduction must allow the personal account to issue commands even when it is also the configured sender. Generated replies must not recursively become commands; verify that distinction in the personal-account test. Handle Twitch challenges and revocations separately. Discord PING verifies independently of guild command admission. Validate the configured Discord application and guild installation context, then route the supplied guild ID without an allowlist. Unsupported Discord contexts return an appropriate private rejection without creating a DM tenant.

Tenant admission transactionally persists work and a deduplication record. Twitch also stores its reply target and earliest recovery alarm before acknowledgement. Discord execution remains attached to the original HTTP request and returns its initial response directly. Duplicate requests use the original timestamp and recorded response or disposition; they never extend a deadline.

Twitch notifications return 204 after durable admission. Discord returns HTTP 200 with a type-4 interaction response once the result is ready. Successful results are public; errors set the ephemeral flag on that initial response. The complete cold path must fit the three-second limit with measured headroom. Bound data requests so a timeout can become a private initial error before that deadline. There is no defer callback request or followup-edit workflow in this baseline. [Discord direct response and timing rules](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Execution, delivery, and recovery

Start work immediately after admission. Twitch retains a durable alarm for recovery; Discord must finish within the original request and does not recover by sending a late background reply. Do not rely on detached fibers or in-memory queues for correctness. Claim work atomically with a generation, perform network I/O outside the storage transaction, and accept completion only for that generation. A single-threaded object still permits interleaving across network awaits. Do not hold object-wide concurrency blocking over upstream requests. [Cloudflare concurrency](https://developers.cloudflare.com/durable-objects/api/state/).

The Twitch work alarm runs the earliest pending action in bounded batches. It recovers interrupted computation while time remains and expires late work without sending. Its timing is not a latency guarantee. At-least-once alarm delivery must converge to the same state. Interrupted Discord work is expired or reconciled on duplicate ingress, never delivered through an unsolicited later callback. [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

TwitchAccount persists a stable send intent and shared rate reservation before calling Helix. It records sending before the external POST. Recovery of an interrupted non-idempotent send becomes ambiguous rather than repeating it. Repeated dispatch of the same attempt reads its recorded outcome. Confirm success using `is_sent`, not HTTP 200 alone. Record `drop_reason` privately. Respect global bot and per-channel limits within the command deadline. [Twitch send contract](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

Discord success and failure use the same initial HTTP response mechanism, with public or ephemeral visibility chosen after computation. No interaction-token POST is needed to create a second message. This removes the prior neutral-edit/private-followup/delete composition and its extra failure states. Test the actual encoded response and client privacy, including cold cache, schema failure, and data timeout. Direct response does not guarantee success during a request crash or provider outage.

Bound result size to provider limits. Twitch can use deterministic chunks only when needed, with a stable attempt for each created message; ambiguity stops remaining chunks. Discord direct responses must fit one initial response, using supported attachments or a bounded presentation if existing output requires it. Verify actual registry outputs before choosing that formatting policy. Suppress unintended mentions and honor each transport's response deadline.

Terminal transitions remove interaction tokens and unnecessary bodies. Keep only bounded token-free replay tombstones and diagnostic summaries. Admission and alarms reclaim expired records. No periodic tenant cleanup loop is added.

## Source-data cache

ArcCache keys include endpoint, canonical query, response-changing flags, and cache encoding version. Preserve ID-first and normalized-search fallback as separate requests. Cache source data, not formatted replies. Serialize through a schema so Effect Option values and other runtime representations survive reconstruction correctly.

On non-event expiry at 24 hours, fetch on demand and validate the consumed fields. Compatible additive fields remain acceptable. Replace the old value only after successful validation. Network errors, bad statuses, or incompatible schema changes leave the last valid value and its timestamp unchanged. Serve it with a short cached-data indication for at most seven days since the successful fetch. With no valid fallback, return a friendly error. Persist a bounded retry cooldown after failed refresh to avoid fetching a known-broken API on every command. The cooldown never extends data validity.

Event schedules expire after 60 seconds and have no expired fallback. Compute active state and countdowns using the current clock for every command.

Coalesce concurrent refreshes per key. Generations prevent an older request overwriting a newer valid result. Bound cache bytes, keys, and query size. Remove fully expired entries on demand without sacrificing a still-valid seven-day fallback. No warming, cache alarm, or operator refresh is added. Diagnostics report resource and schema paths, without dumping chat or credentials.

## Authorization and operations

Setup obtains the configured sender's `user:read:chat`, `user:write:chat`, and `user:bot` grants and broadcaster `channel:bot` grants for that environment's client ID. App tokens create webhook subscriptions and send chat replies. Bind each OAuth state to the intended identity, environment, operator authorization, configuration revision, expiry, and one-time consumption. Verify returned identities against the resolved sender/channel IDs before applying grants. When the personal sender and personal broadcaster are the same account, both roles still require the appropriate grants.

The proposed runtime discards onboarding user access and refresh tokens without revoking them. Continued grant operation after those tokens expire remains an explicit verification gate. Shared app tokens are minted through client credentials instead of refreshed through a user refresh token. [Twitch authorization](https://dev.twitch.tv/docs/chat/authenticating/).

Only TwitchAccount maintains the app-token session. Its narrowly scoped alarm validates the credential at startup and hourly while that session is maintained. This is separate from the rejected optional subscription polling. Twitch documents idle-session validation and no explicit app-token exemption. [Twitch validation requirement](https://dev.twitch.tv/docs/authentication/validate-tokens/).

Setup, configuration changes, and operator repair reconcile subscriptions. Revocation marks the affected channel as requiring attention and stops its sends. There is no scheduled subscription check. Logs and status expose authorization health, subscription status, cache age, schema failure, and command outcome. Redact authorization headers, OAuth query parameters, interaction-token URL segments, and raw bodies.

## Implementation assignments and gates

The user has confirmed this brief. Each worker receives this document, its owned paths, dependencies, and required evidence. Root remains the orchestrator and reviewer. Separate workers use separate checkouts or isolated file ownership. Shared manifests and lockfile have one writer. Execution follows the five units below under the figure-it-out workflow, with decisions recorded in `.audit/cloudflare-migration.tsv` and unit evidence under `docs/verification/`.

| Unit | Owner and scope | Exit gate |
| --- | --- | --- |
| 1. Foundation | One owner for stack, stage/config binding, versions, workspace exports, contracts, Bun test migration, CI, and lockfile. | Alchemy Bun tests with `Cloudflare.state()` and no local mode prove raw HttpApi, SQLite transaction rollback, persisted alarms, and object reconstruction on real Cloudflare infrastructure. Ported command fixtures pass. Test state and credentials cannot select production. Teardown and leftover detection pass. |
| 2. Data and cache | One owner for `packages/arc-data` and affected command injection. | Concurrent refresh, additive and breaking schema updates, round-trip serialization, original timestamps, 24-hour/seven-day/60-second boundaries, and current-clock output pass. |
| 3. Tenant and ingress | One owner for verified ingress, tenant admission, transport-specific deadlines, and direct Discord responses. May run alongside unit 2 after contracts settle. | No tenant allocation on invalid signatures or ordinary Twitch chat. Installed Discord guilds need no enrollment. Duplicates, network interleaving, direct public/private response payloads, cold/missing/expired caches, and deadline behavior pass on real Cloudflare Workers and Durable Objects. |
| 4. Twitch and release sync | One owner for account, authorization, subscriptions, operator client, shared limits, and Discord manifest synchronization. | Personal sender/channel in nonproduction and dedicated sender in production; resolved identities, setup repetition, interrupted creation, validation, revocation, ambiguous sends, secret redaction, and command add/update/delete/readback pass. |
| 5. Integration and deletion | One integrator owns final wiring, manifests, docs, and removal. | Both protocols execute all ten commands. Remove old apps and unused dependencies. Build, typecheck, lint, tests, local Worker execution, and live protocol checks pass. |

Remove the old Twitch and Discord apps, Twurple, Discord.js, libSQL, Turso configuration, obsolete Drizzle schema and migrations, bot process entrypoints, unused platform-bun dependencies, and the exported singleton CommandRuntime. Migrate all existing tests to the Alchemy Effect-aware Bun API, then remove Vitest configuration, Vitest, and `@effect/vitest`. Keep only dependencies consumed by the new application and development tools. Removal can happen in the replacement wave because there is no production compatibility requirement.

Preserve existing command fixtures, normalization, search fallback, queen alias, two-hour upcoming window, and current event boundary behavior. Record existing event-map lookup and boundary discrepancies separately instead of quietly changing them during the migration.

Default CI runs pure Bun unit tests and the real-cloud Alchemy integration suite, then destroys its disposable application stack. Separate live-provider verification uses the personal Twitch sender/channel, a nonproduction Discord application, and a reachable HTTPS endpoint. It must prove direct public success and ephemeral error before the three-second limit, app-token chat delivery, grant survival after onboarding-token expiry, and observed timing. Twitch's three-to-five-second goal is reported only after measuring the real flow. Controlled-provider tests do not register real Discord commands or create real Twitch subscriptions. Disposable Cloudflare test deployments are part of implementation verification; production or persistent staging deployment remains outside this approval.

Free-tier acceptance uses the actual launch configuration and observed counters. Include every subscribed Twitch chat message at ingress, tenant and shared-object requests, external-I/O wall-clock duration, storage writes, and the credential alarm. A low command count alone is not a cost forecast. No usage claim is established yet.

## Synthesis and verification status

Implementation sequencing after acceptance of foundation and cache runs unit 4 before unit 3. The account and release-sync owner establishes the real Twitch dispatch contract before the tenant owner consumes it. This avoids a temporary production sender adapter and keeps one writer for shared stack and test-harness files. Unit scope and acceptance gates remain unchanged.

Candidate A is the base. Root and the independent cross-judge agree on its durable admission, per-work generations, account-level send ledger, and earliest-action recovery. Candidate B's early Twitch acknowledgement, post-deadline recovery, unvalidated generic contracts, and invented timing claims are rejected.

The latest user corrections supersede both candidates' unconditional Discord deferral and static guild enrollment assumptions. Discord now returns direct responses, guilds route without enrollment, Twitch identities/channels are environment-based, registration runs automatically after deployment, and Alchemy Bun integration tests run on real Cloudflare resources with cloud-backed state and per-run teardown. Separate developer-portal applications are confirmed. The earlier callback-plus-202 design was valid under Discord's documentation but is no longer the selected baseline. A broad per-tenant semaphore remains rejected because durable per-work claims protect correctness without serializing unrelated network waits.

Boundary Discipline keeps signature and schema validation at external boundaries. Make Operations Idempotent determines Twitch setup and Discord manifest reconciliation. Laziness Protocol removes guild enrollment and deferred-response machinery. Redesign From First Principles propagates the direct-response choice through state, recovery, tests, and release flow. Separate Before Serializing Shared State isolates environments and implementer write locations. Sequence Work into Verifiable Units puts the adapter proof before parallel implementation. Prove It Works separates planning checks from unperformed live checks.

Planning verification consists of source inspection, published metadata and Bun adapter checks, complete candidate reads, independent review, environment/testing research, and checking this document against the revised session requirements. No runtime, privacy, latency, grant-expiry, command synchronization, cleanup, or cost gate is claimed to have passed. If the three-second Discord gate fails, revisit the choice between bounded private failures and a conditional slow-path defer with the operator. Do not silently restore unconditional deferral. The product frontier is settled and delegated implementation is approved. Record each implementation gate as VERIFIED, NOT VERIFIED, or INCONCLUSIVE using its actual evidence.
