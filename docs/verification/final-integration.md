# Final single-stack integration

This owner record describes application commit `c3bb49e` and its local and controlled-cloud checks. Root subsequently accepted and integrated Unit 5 with the completed-alarm test correction. See the [final root review](final-integration-root-review.md) for current acceptance and final integrated evidence. Live-provider, privacy, onboarding-token-expiry, CI/release, and cost gates remain NOT VERIFIED.

## Revision and ownership

This isolated checkout starts at `8c332b3`, containing the accepted application already integrated. No imports or cherry-picks were needed. The stopped earlier Unit 5 attempt made no source edits, commits, or deployments; none of its missing temporary logs are evidence here. This task used no nested delegates. Root-owned `.audit`, design documents, and every `*root-review.md` remain unchanged.

The throughput checkpoint was frozen installation and a measured baseline, deletion after a consumer census, final health and current operator documentation, uncached local checks, actual local workerd HTTP requests, then one normal canonical cloud run with teardown. A second disposable run is allowed only after concrete progress if the first fails. The unit limit is two.

## Application and dependency changes

`c3bb49e` deletes 22 tracked paths. Twenty comprise the complete `apps/discord-bot` and `apps/twitch-bot` workspaces; two are `packages/commands/src/lib/runtime.ts` and `layers.ts`. The removed apps contain all gateway/prefix/DM process paths, legacy adapter tests, the app database service/schema, Drizzle configuration, and SQL migration files. Root `dev:twitch` and `dev:discord` scripts and the `CommandRuntime` export are removed. The pre-edit consumer census found only those apps importing the singleton and only the singleton using `CommandLayer`. There is no compatibility path.

The shared registry, `executeCommand`, all ten command handlers, normalization, search fallback, queen alias, event boundary behavior, and two-hour upcoming window are unchanged. `packages/testing` remains an active command-fixture dependency, and `packages/utils` remains active. Tenant/cache/account/grant/subscription/dispatch/rate/recovery policy and all 16 signed cross-clock tests are retained without application changes. The single `alchemy.run.ts`, class names, resource identities, strict stage/origin configuration, and test-only provider isolation are unchanged.

Health now returns `status: "ready"`. The actual API schema, Worker, local ingress fixtures, cloud health expectation, controlled provider health, and `ReleaseHealth` registration consumer agree. The stage, revision, and manifest hash fences are retained. One new regression proves incomplete health stops before any Discord command API read/write even when revision and hash match; changing health to ready permits synchronization. Ready means application build identity, not Twitch grant health. Authenticated operator status remains the account-health operation.

The deleted manifests remove direct Discord.js, Twurple auth/easy-bot, Drizzle ORM/kit, libSQL, dotenv, and app-local platform-bun declarations. Root has no direct bot SDK or application database dependency. Ordinary pinned `bun install` regenerated `bun.lock`, followed by successful frozen installation. Lock package records decrease from 365 to 316, a net reduction of 49 keys; 50 keys disappear and one dependency-placement key appears. Unique package identities decrease from 354 to 313, with zero new resolved identities. Hoisted keys for lodash, retry, and detect-libc change placement between already present versions. No framework or dependency upgrade was introduced.

Retained tooling has observed consumers:

- Alchemy remains exactly `2.0.0-beta.83`, Effect exactly `4.0.4`, worker types exactly `5.20261015.1`, and Bun exactly `1.3.5`.
- Root `@effect/platform-bun@4.0.4` is loaded by Alchemy's `Util/PlatformServices.ts` for Bun CLI/test services. Root `@effect/platform-node@4.0.4` supports Alchemy's Worker bridge and Node tooling. The platform-node-shared, sql-sqlite-do, and sql-d1 overrides remain exactly `4.0.4` for beta.83 compatibility.
- Alchemy directly depends on `@libsql/client` and `@distilled.cloud/turso`. `bun pm why` confirms those paths. Bun's normal regeneration also retains the existing Drizzle kit/ORM optional peer selections under Alchemy. They are tooling graph entries, not application imports or direct declarations. Optional Effect/Vitest peer metadata is likewise not an installed or selected test runner.
- Direct `@distilled.cloud/cloudflare` supports cloud resource census/cleanup. TypeScript, Bun types, Biome, Turbo, and the language service remain development tooling.

No tracked current application/config/script/manifest consumes the obsolete credential names. The cloud runner no longer scrubs the obsolete database prefix. Historical inventory and verification records retain their original names and counts. No existing secret-bearing environment file was read or copied. `.env.example` contains only public placeholders and secret names.

Rerunnable scans are:

```bash
rg -n 'CommandRuntime|CommandLayer|discord.js|@twurple|drizzle|@libsql|dotenv|apps/(discord-bot|twitch-bot)' apps packages scripts .github README.md docs/operator-guide.md .env.example --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.turbo/**'
git diff --exit-code 8c332b3 c3bb49e -- alchemy.run.ts .github packages/commands/src/handlers packages/commands/src/registry.ts apps/bot/src/tenant.ts apps/bot/src/twitch-account.ts apps/bot/src/config.ts packages/arc-data/src
```

The first returns no matches. The second exits zero. The legacy credential-name scan also returns no current-code matches. Lockfile entries are assessed through dependency provenance rather than deleted by name.

## Local verification

Every check puts `/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin` first in PATH, including Turbo children.

```bash
export PATH=/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin:$PATH
bun --version
bun install --frozen-lockfile
TURBO_FORCE=true bun run test
bun install
bun install --frozen-lockfile
TURBO_FORCE=true bun run test
TURBO_FORCE=true bun run build
TURBO_FORCE=true bun run check-types
TURBO_FORCE=true bun run lint
git diff --check
```

Initial frozen installation and the uncached baseline pass in this checkout. The baseline is 311 tests and 1,572 assertions. This is independent of root's earlier missing-link failure and successful subsequent installation/rerun.

Final results on `c3bb49e` are:

| Check          | Actual result                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default tests  | 295 pass, zero failures, 1,494 assertions, 31 files. Four workspace tasks execute with zero cached tasks; all eight root strict-helper tests execute afterward. |
| Build          | Four successful tasks, zero cached.                                                                                                                             |
| Typechecking   | Five successful workspace tasks, zero cached, followed by root `tsc --noEmit` exit zero.                                                                        |
| Lint           | One uncached root task; Biome checks 124 files with no changes or errors.                                                                                       |
| Frozen install | Pass after ordinary lockfile regeneration; no subsequent tracked changes.                                                                                       |
| Whitespace     | `git diff --check` passes.                                                                                                                                      |

The exact test arithmetic is `311 - 12 - 5 + 1 = 295`. Removed Discord adapter tests account for 73 assertions and removed Twitch auth-adapter tests for 11. The new health test contributes six, giving `1572 - 73 - 11 + 6 = 1494`. All 294 remaining inherited tests survive. Workspace totals are bot 155/1,146, arc-data 34/117, commands 71/119, and utils 27/39. Root strict helpers contribute 8/73. The 16 full signed clock tests remain included.

Logs live in `.cloud-tests/unit5/`. `unit5-install-baseline.log` and `unit5-baseline-tests.log` retain baseline setup/results. `unit5-install-regenerate.log` and `unit5-install-final.log` retain both lockfile operations. `final-{tests,build,types,lint}.log` retain uncached final checks. No failing source baseline or dependency workaround was hidden.

## Actual local workerd proof and cleanup

The command was the real `bun run dev --stage local-unit-five-c4c91958 --profile default --env-file /dev/null --no-input`, using the unchanged single stack. Both application stage fields match that stage. Runtime configuration uses `personal`, personal sender `local_probe`, only its own channel, fake local portal credentials, and public origin `https://local-unit-five.example`. The Discord verification key is the public RFC fixture key; signing reuses `tests/cloud/signatures.ts`. These values were supplied only for this isolated local process. No production rule, synthetic-stage guard, or provider endpoint was weakened.

Alchemy reported one local Worker at `http://localhost:1337` with the existing ArcCache, Tenant, TwitchAccount, and URL bindings. Requests crossed that actual workerd HTTP listener:

| Request                                   | Observed response                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                             | HTTP 200, `status: ready`, stage `local-unit-five-c4c91958`, revision `unit5-local-proof`, manifest hash `6d2c0e4daaf5ed8fd23ff2cbeae1d3daad1bba923f65c4c057f6e37851da4895`. The probe independently computed and compared the hash. |
| Signed `POST /interactions/discord` PING  | HTTP 200 and exact `{"type":1}`. Raw fixture whitespace is signed.                                                                                                                                                                   |
| Same PING with all-zero invalid signature | HTTP 401 and empty body.                                                                                                                                                                                                             |

No setup, OAuth completion, command, subscription creation, dispatch, or real provider mutation ran. The placeholder HTTPS origin is sufficient for these probes, not live callbacks. Local workerd is complementary development evidence, not cloud integration acceptance.

Ctrl+C stopped the process with exit 130, and a subsequent connection to port 1337 failed with curl exit 7. API census before development found zero stage Workers/namespaces and absent stage state/output. The first post-stop check failed because the remote Alchemy control store still held one `Bot` state entry and output. Its API resource counts were both zero, so this was residual development bookkeeping, not a persistent cloud application deployment. That failed check remains in `local-cloud-after.log` and `local-cloud-poststop-detail.log`.

A separate cleanup called `Core.destroy` for the exact local stage with `dev: true`, matching the actual development providers. It deleted the local Worker and unbound its four bindings. A fresh independent cloud/control-store read then verified zero matching Workers, zero namespaces, zero state entries, and absent output; `alchemy-state-store` remains present. Stage-specific emulator directories and the local bundle were removed. No dev or workerd process remains. `dev: true` was used only for this local-development cleanup, never the integration suite.

The rerunnable local scripts and full outputs remain under `.cloud-tests/unit5/` as `local-http.ts`, `inspect-local.ts`, `destroy-local.ts`, `local-dev.log`, `local-http.log`, `local-cloud-before.log`, `local-destroy.log`, and `local-cloud-clean.log`. The decision trail records the residual-state finding and repair rather than treating process exit as teardown proof. It was reconstructed from this run's artifacts and audited against this thread's messages. Independent trail/comment review is left to root under the explicit no-nested-delegation instruction.

## Canonical real-cloud run

The first authorized run on `c3bb49e` is `bun run test:cloud`, stage `test-tenant-8c6e6c0f-134c2a09a2de`, run `134c2a09a2de`, profile `default`. It uses the unchanged `Alchemy Test.make`/`Cloudflare.state()` real-cloud composition, with no dev flag. The production Bot, Tenant, cache, account policy, and controlled HTTPS providers are exercised. Its resource journal records seven Workers and ten SQLite namespaces. All **29 cases and 631 assertions pass**, including all 15 inherited cases. Test and cleanup exit zero. The suite's `afterAll` destroys all seven Workers, and the independent finally cleanup reads Cloudflare APIs and the control store. It verifies **zero matching Workers, zero matching namespaces, zero stage state entries, and absent output** with the control backend retained. Exactly one of two authorized disposable deployments was used. No failed cloud run, cleanup retry, or second deployment was needed.

This run preserves actual raw-signature/body/freshness/context checks, zero request-local Tenant lookups/RPCs on rejected ingress with a valid positive storage control, first-request useful cold computation, all ten exact command outputs on both actual protocols, cache source counters and current event boundaries, public success/private failure payloads, duplicates without deadline extension, native storage reconstruction/rollback, credential and Tenant alarms, interrupted Discord work, safe original-deadline retry, immutable multipart identity, lost completion, live-dispatch joining, ambiguity, and revocation persistence. The global Discord fixture reads full localization dictionaries, converges the entire manifest, and rejects stale/partial registration. It makes controlled API calls only.

`run.json`, `resources.json`, `result.json`, `timings.json`, `twitch-timings.json`, and `console.log` are retained under `.cloud-tests/test-tenant-8c6e6c0f-134c2a09a2de/`. The same console is `.cloud-tests/unit5/cloud-run-1.log`. The unchanged strict helper treats only the pinned pre-execution Cloudflare 404 placeholder as readiness; no business assertion, unknown POST completion, or executed 500 was replayed to pass. Expected intentional failures within recovery scenarios remain in the successful run's full console. Historical failures in other owner/root records are unchanged.

Retained artifact fingerprints are:

- `result.json` SHA-256 is `e85842725222b4ada679d06cc141f2f21a2770531f0d107d9851dcacaa039794`.
- `resources.json` SHA-256 is `6341ac1891477aa7ba6647b9cbdde247b54936e57d1d5bd75c36ae1c9535377d`.
- `timings.json` SHA-256 is `d341ca6a380e61699a268f797b648015455e7521afe896561b14e8ee328cb387`.
- `twitch-timings.json` SHA-256 is `9643fc570dc28c2ffbf3222cd1e1197360c710fd2b2121bf5b44d8a0e5a17abd`.
- `console.log` SHA-256 is `5c4b046062207664cc4f8ddcaf9859432404d56eb3a1cd0ea7d2406a40426158`.

### Raw timing observations

These are one run of controlled HTTPS providers and synthetic data, not a benchmark, live-provider timing, percentile, or cost estimate. The 22 Discord samples contain 19 useful public responses, including recorded duplicates, and three intended private data failures. Every sample is HTTP 200/type 4, with no Worker command fallback. The ten command samples have public flags zero and committed Tenant success. The slow/missing/malformed samples have flags 64 and committed command-error responses with the exact friendly error text. Assertions compare the useful output, not merely the HTTP status.

Worker duration spans receipt stamping through response construction. Client duration starts after fixture signing and includes the HTTP request plus response decoding. Values below are milliseconds; client values are rounded to three decimals. They exclude Discord network/client display after this HTTP response. Source counters prove the first cold request fetched `initial-cold` once; the later cold `sensors` read adds exactly one fetch, and its three warm requests add zero. Each slow/missing/malformed case adds exactly one attempted source read. Each of the ten Twitch commands reuses the source state captured after its Discord counterpart, with no additional source fetch; signed replay leaves one observed provider message per original parent. Generated personal-account echo leaves the total at ten. Concurrency duplicates fetch their controlled source once.

| Discord scenario                    | Worker ms | Client ms | Visibility    |
| ----------------------------------- | --------: | --------: | ------------- |
| first-http-cold-worker-tenant-cache |      1223 |  1658.080 | public        |
| allocation-positive                 |       381 |   414.292 | public        |
| allocation-stored-duplicate         |        17 |    54.063 | public        |
| cold-cache-cold-tenant              |       430 |   462.451 | public        |
| warm-cache-warm-tenant              |        83 |   127.986 | public        |
| warm-cache-warm-tenant              |        78 |   119.617 | public        |
| warm-cache-warm-tenant              |        84 |   124.208 | public        |
| command-buy                         |       710 |   749.432 | public        |
| command-loot                        |       140 |   178.522 | public        |
| command-craft                       |       147 |   186.839 | public        |
| command-find                        |        77 |   121.505 | public        |
| command-sell                        |        60 |   100.485 | public        |
| command-recycle                     |        62 |    97.286 | public        |
| command-recycleto                   |        63 |    98.020 | public        |
| command-event                       |       158 |   205.753 | public        |
| command-active                      |        62 |   118.559 | public        |
| command-upcoming                    |        63 |   101.224 | public        |
| slow                                |      2209 |  2242.972 | private error |
| missing                             |       502 |   538.430 | private error |
| malformed                           |       386 |   421.115 | private error |
| concurrent-original                 |      1725 |  1791.063 | public        |
| concurrent-duplicate                |      1458 |  1687.592 | public        |

Across all 22 samples, maximum Worker time is 2209 ms and maximum client time is 2242.972 ms, both from the intended slow private failure. The corresponding observed headroom below 3,000 ms is 791 and 757.028 ms. Among the 19 useful public responses, maxima are 1725 and 1791.063 ms; their observed headroom is 1275 and 1208.937 ms. These maxima describe this sample set only. The controlled slow case deliberately waits on data; no causal performance improvement or general latency guarantee is inferred.

Twitch acknowledgement includes durable admission before 204. Delivery observation ends when the client sees the controlled provider's recorded message through fixture polling; it includes that polling delay. It is neither an actual Twitch delivery time nor a provider arrival guarantee.

| Twitch command | Worker ack ms | Client ack ms | Client delivery observation ms |
| -------------- | ------------: | ------------: | -----------------------------: |
| buy            |           369 |       406.793 |                        743.363 |
| loot           |            84 |       118.476 |                        468.000 |
| craft          |            83 |       121.732 |                        751.709 |
| find           |            87 |       169.357 |                        501.714 |
| sell           |            83 |       126.664 |                        751.188 |
| recycle        |            79 |       118.695 |                        738.994 |
| recycleto      |            80 |       114.557 |                        454.107 |
| event          |            74 |       111.967 |                        732.524 |
| active         |            90 |       130.794 |                        458.632 |
| upcoming       |            91 |       132.827 |                        764.493 |

Observed maxima are 369 ms for Worker acknowledgement, 406.793 ms for client acknowledgement, and 764.493 ms for fixture delivery observation. The controlled suite also asserts each send occurs before its original ten-second cutoff. No profiler, repeated performance comparison, or live-provider run was performed, so no bottleneck, speedup, p95, or throughput claim is made.

## Current operator flow and CI

[The README](../../README.md), [operator guide](../operator-guide.md), and [public environment template](../../.env.example) document the pinned commands and configuration. They distinguish authentication profile from application stage, separately active portal applications, personal-only local/staging channels, production dedicated sender/manual channels, deployed `Worker.URL` origin, explicit local HTTPS tunnel, exact webhook/OAuth routes, private secret injection, grant links and repeated setup, revocation repair, direct responses, and quiet-launch replay/capacity bounds.

CLI flags and secret loading were checked against the installed beta.83 help and `Util/ConfigProvider.ts`, `Cli/commands/flags.ts`, and `Stack.ts`. There is no invented application-secret command. Explicit Alchemy `--env-file` overrides the process for listed names; absent that flag, exported environment overrides optional `.env`. Bun's `--env-file` loads standalone ops/sync scripts, whose endpoint and revision are explicit arguments. Public shell exports and the protected file must agree. Secrets are never supplied as CLI argument values.

CI and release workflows are unchanged after consumer inspection. CI pins Bun 1.3.5, uses frozen install and default checks, then canonical real-cloud tests with mandatory credentials. Finally cleanup and JSON recovery artifacts remain. Names `CLOUDFLARE_TEST_ACCOUNT_ID` and `CLOUDFLARE_TEST_API_TOKEN` remain. Release accepts staging/prod explicitly, serializes by Discord application ID, deploys first, then runs global full-manifest sync with exact revision/hash/ready fences and readback. Runtime/CLI Discord token configuration remains.

No GitHub settings, secrets, workflow execution, release stage, push, or PR was changed. Remote CI/release configuration is NOT VERIFIED; no read-only metadata was available or claimed.

## Remaining acceptance gates

Root must independently review the implementation/comments, verify the exact integrated revision, and decide Unit 5 acceptance. This owner does not accept its own unit on root's behalf. Prior accepted unit/root records remain unchanged, including their failed historical runs and unresolved historical causal attribution.

The following live checks remain NOT VERIFIED. They require separately authorized portal applications and private credential injection, not secrets in chat:

1. On separate nonproduction Twitch and Discord applications, deploy a selected environment or use a reachable local HTTPS tunnel. Run setup with the personal sender/channel, complete every returned grant link as its intended identity, repeat setup, and verify a signed challenge followed by enabled notification delivery.
2. Send all ten actual Twitch commands in that personal channel. Check exact outputs, app-token send identity, parent-message association, self-reply recursion prevention, revocation blocking, and repeated setup repair. Record original receipt through actual delivered-message timing with sample count and source-fetch counts. Controlled fixture timing is not live delivery timing.
3. Let onboarding user tokens expire without revoking their grants. Confirm app-token EventSub and chat still work after expiry and account reconstruction. Record the observed expiry interval and independent grant state. Local fixtures do not establish Twitch's continued grant behavior.
4. Register the nonproduction Discord global manifest through the exact deployed revision. Read back full definitions, verify add/update/delete and localization drift repair, then confirm propagation in an actual client. Install in an additional guild without enrollment. Verify public successes and private errors with another guild member, including cold, warm, malformed, missing, and timed-out data, all within the real initial-response deadline. Confirm no DM/prefix behavior or later token reply.
5. Read remote CI/environment metadata under separate authorization; confirm test-account variables/secrets, stage-specific applications/secrets, and release serialization. Run authorized CI and a nonproduction release, retaining teardown artifacts and exact registration evidence. No such run was started here.
6. Observe actual quiet-launch counters before any cost claim. Include all subscribed Twitch chat ingress, Worker/DO requests, external-I/O wall time, storage writes, shared credential alarms, and retained control-backend use. The 64-record/120-KiB Tenant and 64-attempt account replay limits can reject before remote rate limits. These bounds are documented; no new dashboard, alerts, cache warmer, or cache alarm was added.

Laziness Protocol limited implementation changes to deletion and final health. Migrate Callers Then Delete Legacy APIs removed the singleton with its last callers. Model the Domain retained the accepted transport-specific work/account shapes. Prove It Works required actual workerd requests, cloud protocol execution, persisted evidence, and API teardown checks. Explain the Number restricts timing to raw single-run observations with exact fixture scope; no speedup, percentile, live-provider, throughput, or cost guarantee follows.

The final documentation/evidence commit changes only `.gitignore`, `.env.example`, `README.md`, `docs/operator-guide.md`, this record, and the verification index. Application sources, manifests, scripts, workflows, tests, and lockfile remain exactly `c3bb49e` after cloud verification. There are 22 removed and three new tracked paths, a net reduction of 19. No production or persistent staging deployment, actual Twitch/Discord mutation, external message, push, PR, or GitHub Actions run occurred.
