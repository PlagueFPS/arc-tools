# Twitch account and Discord release verification

This is the original unit 4 worker record. Its historical cloud passes do not verify the subsequently corrected account implementation. [Account integration verification](account-integration.md) records the combined commits, the corrected 33-state OAuth bound and subscription-intent adoption rule, local results, and the open native cloud gate. Unit 4 remains unaccepted.

Unit 4 starts at `9a19eacc2a62dfbf54cc5d2e1ede8f18367d472f`. Unit 4 implementation gates are VERIFIED locally and on real Cloudflare with controlled providers. Root owns review and integration. Unit 3 and unit 5 remain outstanding.

## Architecture recorded before implementation

The approved architecture is retained. The existing Worker currently serves health only. Its configuration already distinguishes dedicated production, personal staging/local, and synthetic disposable stages. The accepted cache adapter demonstrates construction-time binding discovery, runtime service closure, short native transactions, and generation fencing. No tenant or signature route is added here.

Caller usage is `yield* (yield* TwitchAccount).dispatch(request)`. `request` has the existing branded attempt ID, broadcaster ID and absolute epoch-millisecond deadline, a reply-parent ID, and text bounded to 500 characters. Results are a schema-derived union of sent, rejected, retryable with an absolute retry time strictly before the deadline, ambiguous, and expired. Unit 3 retains a stable attempt and original deadline across retries. It stops on ambiguity. Operator setup, OAuth completion, status, and signed-ingress subscription observations are named account operations.

One environment account DO owns a schema-validated persisted record. It contains resolved identities, grant facts without onboarding tokens, OAuth state digests, subscription ownership, token session and claims, rate reservations, and bounded send records. Network calls occur outside storage transactions. Each completion compares the persisted claim and configuration revision. A sending intent survives reconstruction and becomes ambiguous rather than repeating a POST. No object-wide lock spans external I/O.

Focused modules will own account contracts and state, bounded Twitch HTTP, account policy, and the Cloudflare adapter. `operator.ts` owns authenticated bounded HttpApi handlers. `scripts/ops.ts` selects an explicit stage and endpoint. `discord-manifest.ts` derives owned global fields from the ten-command registry. `discord-sync.ts` owns normalized read/compare/overwrite/readback and release-health fencing. The release workflow serializes by target application, deploys an explicit stage, waits for the exact build/hash, and runs the same checkout's sync client.

The service-design branch is selected. Account, provider HTTP, and durable storage are authority seams. Configuration, manifest normalization, and policy calculations are values or pure functions. Architecture exploration and delegates are omitted because the user explicitly requires the approved architecture and a sole implementation writer. The throughput checkpoint is to implement the typed contracts, account behavior, release behavior, then the shared controlled-provider cloud fixture. Each part ends in a behavior check before integration.

## Official provider evidence

Reviewed 2026-10-15. [Twitch chat authentication](https://dev.twitch.tv/docs/chat/authenticating/) lists sender `user:read:chat`, `user:write:chat`, `user:bot`, broadcaster `channel:bot`, and app tokens for webhook subscriptions. [Token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/) requires startup and hourly checks while maintaining a session. [OAuth authorization code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow) defines code exchange and state.

[Chat limits](https://dev.twitch.tv/docs/chat/#rate-limits) describe shared account limits and the separate Send Chat Message API bucket. The implementation will conservatively reserve 20 messages per rolling 30 seconds and one per second per channel, without assuming moderator/VIP/verified privileges. [Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message) defines the 500-character limit, `is_sent`, private drop reason, and source-only shared-chat option.

[Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription) requires prior grants, HTTPS callback and a 10-to-100-character ASCII secret, and documents duplicate condition conflicts. [Get EventSub Subscriptions](https://dev.twitch.tv/docs/api/reference/#get-eventsub-subscriptions) defines cursor pagination. [Subscription management](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/) supplies reconciliation and deletion semantics. List-before-create and persistent ownership converge after interrupted creation; no claim is made that the provider offers a transaction.

[Discord application commands](https://docs.discord.com/developers/interactions/application-commands) defines guild installation/context values and full global overwrite. [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits) requires respecting 429 retry timing. There is no deployment/registration transaction. Health fencing detects stale revisions and post-sync changes, and partial failures must fail the release.

## Live gates

Real setup awaits signed webhook challenge/revocation ingress from unit 3. No placeholder webhook success route is present. Real Twitch grant survival after discarded onboarding-token expiry, provider delivery, live Discord registration, CI credentials, and release execution are NOT VERIFIED. No live-provider mutation or persistent stage deployment is authorized in this unit.

## Final ownership and unit 3 integration

`apps/bot/src/twitch-contracts.ts` exports `TwitchAccount`, `Dispatch`, `DispatchOutcome`, `OAuthCompletion`, `SubscriptionObservation`, `AccountStatus`, `SetupResult`, and `AccountError`. It reuses the foundation's `AttemptId`, `BroadcasterId`, and `Deadline` brands. `ReplyId` distinguishes the reply-parent message. The dispatch deadline is absolute Unix epoch milliseconds. Input text is nonempty and at most 500 characters. Unit 3 owns command-output presentation and stable attempts for any chunks. An ambiguous chunk stops subsequent chunks.

```ts
const account = yield * TwitchAccount;
const outcome =
  yield *
  account.dispatch({
    attemptId,
    broadcasterId,
    replyParentId,
    text,
    deadline,
  });
```

`sent` carries the provider message ID. `rejected` carries no private reason. `retryable` carries absolute `retryAt`, strictly before the original deadline. `ambiguous` and `expired` carry no message. Unit 3 must retain the same complete input across retries, wait until `retryAt`, and stop on a terminal result. An attempt reused with different content or deadline is rejected while retained. Terminal records last until ten minutes after the original deadline. Reclamation cannot repeat the original input because its absolute deadline has expired. This is bounded replay retention, not an unlimited history of arbitrary reused IDs.

The adapter is `apps/bot/src/twitch.ts`. `TwitchAccountDO` binds one native SQLite object named `environment` per stack stage. `bindAccount` discovers the namespace during host construction and returns the runtime client effect. In a tenant DO, yield `bindAccount` in outer construction, yield the returned client in inner runtime construction, and provide `Layer.succeed(TwitchAccount, client)` to tenant operations. `makeClient` flattens those effects, and `layer` provides the complete service where both construction and runtime capabilities are available. Native RPC and storage failures become sanitized errors or defects. No provider request object, bearer token, or generic arbitrary RPC is part of the tenant contract.

After verifying a signed `channel.chat.message` notification, unit 3 calls `observeSubscription` with its subscription ID, broadcaster ID, sender ID, and `enabled` status before dispatch. A verified notification is evidence that delivery is enabled. A challenge alone retains `webhook_callback_verification_pending`; it does not prove Twitch accepted the acknowledgement. A signed revocation passes the actual provider status. Observations check configured resolved identities, retain revoked IDs, and fence older OAuth/setup completion. Enabled observations survive a stale pending list response. Unit 3 must continue to reject unknown or mismatched subscription types, application ownership, channels, signatures and replay at ingress. This unit supplies no unsigned production shortcut.

`accountRuntimeConfig.webhookReady` is deliberately `false`. Unit 3 changes that composition decision only when signed challenge, notification and revocation ingress exists. Until then live setup can resolve logins and collect validated grants, but returns `ingress-required` and creates no real subscriptions. `ARC_PUBLIC_URL` must be the stage's HTTPS origin. OAuth redirects use `/oauth/twitch/callback`, and future signed EventSub ingress uses `/webhooks/twitch`.

`makeAccount` owns policy behind `AccountStore` and `TwitchProvider`. The Cloudflare adapter closes over native storage and runtime context. `twitch-state.ts` owns the schema, short transaction interface, reclamation, and rolling limits. `twitch-provider.ts` owns named Twitch operations. `provider-http.ts` bounds response bytes and time and replaces raw failures with safe codes. External calls never run inside a storage transaction. Session/claim changes and the next native credential alarm commit in the same transaction. A credential-only semaphore coalesces live refreshes; persistent expiring claims and revision/generation checks protect reconstruction. Setup's persistent lease is bounded at two minutes. Credential acquisition's lease is ten seconds. Neither blocks unrelated account calls during network waits.

The account keeps at most 32 channels, 32 outstanding OAuth states, 64 attempts and 20 recent send reservations. The adapter enforces a conservative 120 KiB encoded record ceiling. [Cloudflare SQLite storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/) permit a combined key/value of 2 MB. Attempts contain hashes, deadlines, outcomes and bounded private diagnostic codes, without reply bodies. User onboarding access and refresh tokens never enter durable state. The account stores only the app session and validated required grant facts. OAuth state stores a nonce digest, intended identity, role union, operator-secret digest, configuration revision, authorization generation and expiry. It is consumed before code exchange. Configuration replacement and signed revocation fence late completions.

Credential construction schedules a prompt startup validation alarm for an existing session. Dispatch also requires validation in the current instance. Subsequent checks occur hourly or before expiry. Refresh/validation failure gets a bounded credential retry and stops after three failures until explicit activity repairs it. There is no subscription polling, per-tenant cron, or cache refresh command. An explicit Helix 401 invalidates only the token generation used by that request. A 429 provides a bounded retry time. Successful rate-limit exhaustion headers also block shared sends until reset. Unknown POST, timeout, malformed success or 5xx is ambiguous. `is_sent: false` is an explicit rejection; a bare HTTP 200 is insufficient.

Subscription reconciliation lists every cursor page before mutation, adopts matching type/version/condition/callback records, removes obsolete chat webhooks owned by this environment's dedicated application, and lists again after creation. Interrupted creation is adopted on repair. Twitch documents duplicate condition conflicts, but does not provide an application transaction or a send idempotency key. A stored callback/client/signing-secret fingerprint replaces known subscriptions on binding changes. The list response does not reveal secrets, so initial adoption cannot prove an unknown existing subscription's secret. Real signed delivery remains a live acceptance gate.

## Operator and release operation

`bun run ops setup --stage <stage> --endpoint <https-origin>` and `bun run ops status --stage <stage> --endpoint <https-origin>` require `OPERATOR_SECRET` in the process environment. Endpoint credentials, query strings and fragments are rejected. There is no implicit production endpoint or identity. Setup prints authorization links for the intended accounts. Open each link, authorize the exact account, then rerun setup. The public OAuth callback is authorized by the one-time state capability minted by authenticated setup and bound to the current operator-secret digest. It consumes the one-time state before exchange and checks the stage/configuration, operator binding, returned client, identity and scopes before saving a grant. Rotating the operator secret invalidates outstanding callbacks.

`POST /ops/setup` and `POST /ops/status` require bearer authorization and a bounded JSON stage selector. Status contains operational identity/grant/subscription facts, record counts and credential-check time. It never dumps credentials, nonce state or private drop reasons. Operator bodies are limited to 4096 bytes; operations and callback handling have bounded timeouts. Responses use no-store and no-referrer headers. HTTP request logging and tracing are disabled for this Worker, including Cloudflare invocation logs and automatic traces, so OAuth query parameters are not recorded by the application's default instrumentation. Explicit dispatch logs include the outcome only. Native provider failures and CLI errors omit request URL, headers, body, authorization code and tokens.

`ops status --discord --revision <revision>` performs an explicit read-only drift check using that environment's `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN`. `bun run sync:discord --stage <stage> --endpoint <https-origin> --revision <revision> --wait` waits for the exact checkout revision and manifest hash, then reconciles the application's complete global command set. There are no guild IDs or guild registration calls.

The manifest owns command names, descriptions, string options, guild installation/context restrictions, permissions default, NSFW default and localization fields. Comparison ignores generated IDs and versions and normalizes documented defaults. It preserves option order and command-set equality independent of server order. Drift triggers a full overwrite followed by independent GET verification. Unchanged commands skip PUT. Four attempts and a thirty-second retry budget bound 429 handling. Every read and write checks release health again, and the final check detects a deployment changing during registration. An overwritten API followed by failed readback or a newer deploy fails the operation. Neither the script nor health claims atomic deployment and registration or immediate Discord client propagation.

`.github/workflows/release.yml` is manually triggered with an explicit `staging` or `prod` stage and the target application ID. The entire job serializes by that application ID, without canceling an active release. It checks the input against the selected environment's application ID, checks out the exact SHA, installs frozen dependencies, builds, checks types, lints, tests, deploys that stage and runs the same checkout's health-fenced synchronization. It records a partial release if deployment succeeded but synchronization failed. No workflow was triggered and no GitHub settings or secrets were written here.

Configure these names separately in each GitHub environment before a live release. Variables are `ARC_PUBLIC_URL`, `ARC_ENVIRONMENT`, `TWITCH_SENDER_KIND`, `TWITCH_SENDER_LOGIN`, `TWITCH_CHANNEL_LOGINS`, `TWITCH_CLIENT_ID`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `CLOUDFLARE_ACCOUNT_ID`. Secrets are `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_BOT_TOKEN`, `OPERATOR_SECRET`, and `CLOUDFLARE_API_TOKEN`. The workflow supplies stage, application stage and build SHA. Portal redirect/interaction URLs and separate application identities must agree with those values. Their remote configuration is NOT VERIFIED.

The existing default CI cloud test remains in place. Its runner now defaults to the combined account suite and retains `foundation` and `cache` selection. Existing CI variables `CLOUDFLARE_TEST_ACCOUNT_ID` and secret `CLOUDFLARE_TEST_API_TOKEN` remain the disposable deployment credentials. No GitHub credential configuration is assumed.

## Verification record

Final verification used Bun 1.3.5, Effect 4.0.4 and Alchemy 2.0.0-beta.83. All tests use `alchemy/Test/Bun` with `bun:test` expectations. The accepted command, data and cache implementation files remain unchanged. Existing fixture assertions for all ten commands still run.

The deterministic account cases cover returned identity/client/scope mismatch, replay, expiry equality, operator/configuration changes, personal role union, subscription adoption and repair, token contention/startup validation, global/channel limits, absolute deadlines, non-idempotent ambiguity, stable outcomes, bounded reclamation, explicit 401 repair, revocation racing OAuth exchange, signing-secret rotation, and enabled observations racing stale pending lists. Provider HTTP tests cover `is_sent`, private drop codes, malformed success, 5xx, 401/429, source-only messages, pagination and sanitized failures. Discord HTTP tests cover registry payloads, defaults, no-op, add/update/delete, bounded 429, failed readback and stale revisions before and after PUT.

The cloud fixture runs the same `makeAccountRpc`, `makeAccountStorage`, `makeAccount`, provider HTTP and dispatch code as production. Its separate provider Worker is reachable over HTTPS and controls tokens, identities, paginated subscriptions, held creation/sends and Discord registration. Only `tests/cloud` contains time, reconstruction, configure and release controls. Native `state.abort` changes the construction UUID and retains the account record. The fixture's clock is independent of production adapters. Setup and send interleaving continue while external requests are held. Controlled provider calls do not reach Twitch or Discord.

The combined stack contains six Workers and six SQLite namespaces, including the production account binding in the health/operator Worker. The runner rejects local mode, uses `Cloudflare.state()`, selects a unique worktree/run stage, and verifies teardown through Cloudflare API lists plus absent stage state/output. Readiness retries are separate from business assertions. Fixture POST retries handle only route-publication 404. Business failures are retained rather than retried.

The first stage `test-account-a0e65c16-00e210f8b802` passed all eight foundation/cache cases and failed five account cases before provider requests reached the fixture. Runtime source inspection found the unsupported redirect mode. [Cloudflare workerd's request parser](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B) rejects `error` mode and requires `manual` plus status checking. The adapter was corrected. The failed stack's API/state cleanup passed.

Stage `test-account-a0e65c16-ff53b465ea26` then passed 13 tests and 213 assertions. Stage `test-account-a0e65c16-10cbf35700d8` added cloud Discord synchronization and captured account-log assertions and passed 14 tests with 226 assertions. Stage `test-account-a0e65c16-0862b625cd0d` added authenticated production-adapter status and a real Bun operator CLI call and passed 14 tests with 232 assertions. Each stack's teardown independently reported zero remaining Workers/namespaces and absent state/output. Stage `test-account-a0e65c16-84b6347470ee` passed 14 tests and 232 assertions after the final notification-state correction. Stage `test-account-a0e65c16-2d68f31d1912` passed the same 14 tests and 232 assertions after durable authorization rejection was added. The final stage `test-account-a0e65c16-2a92274012c2` passed 14 tests and 234 assertions after session/alarm writes were made atomic, including persisted alarm assertions. Every stage retains `run.json`, `resources.json`, `result.json`, and the captured console log under `.cloud-tests/<stage>/`.

The initial lint check failed only because the newly expanded cloud test needed formatting. Biome applied that formatting. No business assertion, timeout gate, original command output, or provider outcome was weakened.

## Scope and remaining gates

Model the Domain put send intent, grant generation and credential claims in durable state. Make Operations Idempotent selected list/adopt/readback reconciliation and terminal send outcomes. Boundary Discipline and Type System Discipline kept schemas at HTTP/RPC/storage boundaries and reused existing brands. Build the Lever extended the existing reproducible cloud runner and added release clients. Prove It Works required native reconstruction, observed provider POST counts, actual operator CLI execution and API cleanup.

No delegates were spawned, no root orchestration playbook was run, and no root audit or accepted review document was edited. Root retains independent review and integration. The user required the approved design, so architecture alternatives, delegated comment review and delegated trail review were not run. Added application code contains no comments or suppressions. The final diff is inspected locally; this does not substitute for root review.

Live Twitch authorization after onboarding-token expiry, real signed EventSub delivery/revocation, real chat receipt/latency, Discord initial-response privacy/timing, live nonproduction registration, CI execution, portal settings and launch cost remain NOT VERIFIED. No production or persistent staging deployment, real Twitch subscription, live Discord command registration, provider account change, push, merge or PR occurred. The full migration remains incomplete until unit 3, unit 5 and the live-provider gates pass.

## Final checks and handoff

The implementation worktree is `/home/angel/.t3/worktrees/arc-tools/t3-5b69d597`, on branch `t3/twitch-account-discord-sync`, based on `9a19eacc2a62dfbf54cc5d2e1ede8f18367d472f`. The delivery commit is reported with the handoff. The final shape matches the pre-code sketch, with explicit authorization generations, subscription-binding fingerprints, and atomic alarm storage added during concurrency review.

Required checks passed.

```text
bunx bun@1.3.5 install --frozen-lockfile
Checked 256 installs across 355 packages. No changes.

bunx bun@1.3.5 run build
4 successful tasks.

bunx bun@1.3.5 x turbo run build check-types test --force
17 successful tasks. Zero cache hits.

bunx bun@1.3.5 run check-types
7 successful tasks plus root tsc --noEmit, exit 0.

bunx bun@1.3.5 run lint
Biome checked 119 files. No fixes or errors.

bunx bun@1.3.5 test ./packages/utils/test ./packages/arc-data/test ./packages/commands/test ./apps/discord-bot/test ./apps/twitch-bot/test ./apps/bot/test
181 pass, 0 fail, 580 assertions across 24 files.

bunx bun@1.3.5 run scripts/cloud-test.ts account
14 pass, 0 fail, 234 assertions.
Final stage test-account-a0e65c16-2a92274012c2.
Cloud tests exit 0; cleanup exit 0.
CLEANUP VERIFIED: zero matching Workers, zero DO namespaces,
no stage state/output; control backend retained.

git diff --check
Exit 0.
```

The forced run preceded the final account-only corrections. The final type, lint, 181-test and real-cloud checks ran after those corrections. No accepted data/cache/command implementation changed between checks. Final stage logs and the local decision trail are under `.cloud-tests/`. The evidence records every failed run and every cleanup result; it makes no live-provider success claim.

Cleanup was explicitly repeated with `bunx bun@1.3.5 run scripts/cloud-test.ts cleanup test-account-a0e65c16-2a92274012c2`. It again returned exit zero with zero Workers/namespaces and absent state/output. The control backend was retained.
