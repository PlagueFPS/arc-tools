# Data and cache verification

Status is **VERIFIED for unit 2 implementation gates** on 2026-10-15. The implementation commit is `69d99524b2497e7aaeb1d35dac396dd05370203f`.

Unit 2 starts from accepted foundation `a1ff8e5` on branch `t3/unit2-data-and-cache` in `/home/angel/.t3/worktrees/arc-tools/t3-3c977d3b`. Root review and integration are separate gates. This record covers data reads, caching, and command computation. It does not establish provider delivery, ingress validation, or Discord response timing.

## Contracts for subsequent owners

The application service and existing domain operations come from `@arctools/arc-data`.

```ts
import type { Effect } from "effect";
import {
	ArcData,
	DataUnavailable,
	fetchArc,
	getEvents,
	getItem,
	getTraders,
	selectEvent,
	type Arc,
	type Event,
	type Item,
	type TradersAPIResponse,
	type DataRead,
	type ItemAPIParams,
	type ArcsAPIParams,
} from "@arctools/arc-data";
```

`ArcData` is a `Context.Service` with these methods. Each Effect requires no additional services after construction.

```ts
items(params: ItemAPIParams): Effect.Effect<DataRead<readonly Item[]>, DataUnavailable>
arcs(params: ArcsAPIParams): Effect.Effect<DataRead<readonly Arc[]>, DataUnavailable>
traders(): Effect.Effect<DataRead<TradersAPIResponse["data"]>, DataUnavailable>
events(): Effect.Effect<DataRead<readonly Event[]>, DataUnavailable>
```

`DataRead<A>` contains `value: A` and `provenance: { freshness: "fresh" | "fallback"; fetchedAt: number }`. `fetchedAt` is the last successful validation time in Unix epoch milliseconds. Each method returns schema-decoded application values, including Effect `Option` fields. Callers never receive HTTP responses, provider SDKs, storage rows, or unconstrained `get<T>` results.

`getItem(params)` and `fetchArc(params)` still return the first result as an `Option`. `getTraders()` and `getEvents()` still return the decoded data. These operations now require `ArcData` rather than `HttpClient`. `selectEvent(events, search)` retains its current-clock selection behavior.

`ItemAPIParams` has optional `id`, `search`, `includeComponents`, `minimal`, and `limit` fields. `ArcsAPIParams` has optional `id`, `search`, and `includeLoot` fields. Arc reads default `includeLoot` to true. ID and normalized search remain separate requests. No normalization was added to the service that could change an existing lookup.

The Cloudflare composition root imports the adapter separately.

```ts
import { layer as ArcCacheLayer } from "@arctools/arc-data/cloudflare";
import { executeCommand } from "@arctools/commands";
```

`ArcCacheLayer` has type `Layer.Layer<ArcData, never, Cloudflare.Worker | RuntimeContext>`. Build it during the hosting Worker's or tenant adapter's construction, while Alchemy can discover bindings. It binds the private `ArcCacheDO` namespace and always uses `getByName("environment")`. All tenants in that environment share this one object. Its production RPC exposes only `read`. There is no production reset, time override, refresh endpoint, alarm, or polling loop.

The execution contract comes from `@arctools/commands`.

```ts
executeCommand(request: CommandExecution): Effect.Effect<CommandReply, CommandError, ArcData>

interface CommandExecution {
	readonly command: CommandName;
	readonly input: string;
	readonly deadline: number;
}
interface CommandReply {
	readonly text: string;
	readonly stale: boolean;
}
```

`CommandName` and `CommandExecution` are also exported schemas. Names derive from the existing ten-command registry. Input is limited to 256 characters. The deadline is an absolute Unix epoch millisecond timestamp, compatible with the foundation `Deadline` brand. Ingress retains responsibility for transport parsing and receipt-based deadlines.

Provide the constructed `ArcData` context to `executeCommand`. Each execution allocates its own provenance accumulator. If any successful data read used fallback, including an empty ID lookup before a successful search, `text` ends in ` [Using cached data]` and `stale` is true. Concurrent tenants cannot share this accumulator. Data unavailability becomes a `CommandError` with `Game data is temporarily unavailable. Please try again shortly.` If fallback was consumed before a later failure, the error's `stale` field and `message` retain the same cached-data indication. The execution respects its remaining deadline.

Legacy bots still use `CommandRuntime`, now composed with an uncached `ArcData` implementation and `FetchHttpClient`. Their removal remains unit 5. New ingress and tenant code must use `ArcCacheLayer` and `executeCommand`. The shared HTTP fixture now provides both its HTTP capability and this typed data service. Arc-data's own tests use a local fixture to avoid a circular workspace dependency. No legacy bot application files changed in unit 2.

## Cache ownership and policy

`packages/arc-data/src/data-service.ts` owns the typed port and request schemas. `source.ts` owns upstream HTTP and bounded schema decoding. `cache.ts` owns freshness, admission, cooldowns, concurrency, and encoded values. `cloudflare.ts` owns the native storage and RPC adapters. Only the adapter subpath imports Alchemy and Cloudflare capabilities.

The organizing data structure is a bounded set of persistent entries. Each entry has an encoded validated value or null, a successful timestamp, a generation, a refresh lease, and a retry timestamp. A separate persistent generation counter survives entry reset. Short native transactions claim refreshes and accept completions. Network I/O happens outside transactions.

Per-key Effect semaphores coalesce requests in the live object. Independent keys can progress during a slow request. The persistent lease prevents a reconstructed instance from duplicating an unfinished refresh immediately. It expires after the source timeout plus one second. Completion compares its stored generation before writing. Reset retains the generation counter, so a late completion cannot overwrite a newer result.

The production constants are in `source.ts`.

- Metadata is fresh while its age is less than 86,400,000 milliseconds. Expiry triggers a source fetch on demand.
- Metadata fallback is valid through exactly 604,800,000 milliseconds after successful validation. It fails at that age plus one millisecond.
- Failed refreshes persist a 60,000 millisecond cooldown. A failure changes neither the value nor its successful timestamp. Cooldown does not extend fallback validity.
- Schedules are fresh for less than 60,000 milliseconds. Expired schedules have no fallback.
- Source requests time out after 1,800 milliseconds. The stream reader rejects a body over 1 MiB before parsing it.
- Admission allows 128 entries, 96 KiB per encoded value, and 4 MiB of encoded value bytes in total. Keys are limited to 2,048 UTF-8 bytes. Query text is limited to 256 characters per field and `limit` to integers from 1 through 100. Row metadata is bounded by the entry count.

Keys have the form `v1:json:/items?id=sensors&includeComponents=true`. They include the endpoint, sorted query, every requested response flag, limit, and encoding/schema version. Explicit false and omitted flags remain distinct. New queries cannot evict usable metadata fallback to make space. Fully expired entries are reclaimed on demand. An oversized source value leaves the original fallback intact.

Successful source decoding accepts additive fields and strips unconsumed fields before schema encoding. Status, network, timeout, parse, and schema failures preserve the previous entry. Logs include the resource and schema paths rather than raw source bodies. Encoded values pass through the same schema after JSON and RPC reconstruction. Arc loot now uses the optional/null Option codec already used by items. The old codec encoded `None` as an omitted required key and failed its JSON round trip.

Only source data is cached. Active state, event selection, countdowns, the queen alias, and the two-hour upcoming window use the current clock on every execution. The existing name-only event search and exclusive `selectEvent` end boundary remain. `activeHandler` retains its inclusive end boundary.

## Local behavioral evidence

The preexisting 128 tests remain. Their handler assertions still verify all ten commands, normalization, search fallback, event quirks, and transport adapter fixtures. New tests exercise cache reads through the real policy implementation with a controlled Effect clock. Their local storage fixture serializes rows and provides a short transaction mutex. It is not the real-cloud acceptance substitute.

`packages/arc-data/test/cache.test.ts` covers cold reads, hits, exact expiry, additive and broken fields, malformed JSON, bad statuses, network failure, no fallback, persistent cooldown after reconstruction, original timestamps through day seven, Option/null/omitted/empty round trips, endpoint and flag keys, byte and entry limits, concurrent same-key refresh, independent keys, interrupted leases, source timeout, and generation fencing after reset.

`packages/commands/test/execute.test.ts` covers concurrent provenance isolation, stale lookup misses followed by success or failure, current event clocks, preserved boundaries and aliases, schedule failure, expired command deadlines, and exact outputs for all ten commands through the cache. A second pass over those ten commands makes no new source calls.

The final host checks used Bun 1.4.2. These required commands passed.

```text
bun install --frozen-lockfile
Checked 256 installs across 355 packages, no changes.

bun run build
4 successful tasks.

bun run check-types
7 successful tasks and root tsc exits zero.

bun run lint
Biome checks 102 files, no fixes.

bun run test
All six package suites pass.
```

The final uncached command was `bunx turbo run build check-types test --force`, followed by `bunx tsc --noEmit`. It completed 17 tasks with zero cache hits. Lint also passed after the last command-code change. The exact pinned-runtime command was:

```sh
bunx bun@1.3.5 test ./packages/utils/test ./packages/arc-data/test ./packages/commands/test ./apps/discord-bot/test ./apps/twitch-bot/test ./apps/bot/test
```

It reported 149 passing tests, zero failures, and 377 assertions across 21 files. There are 16 cache-policy tests and five command-execution tests in addition to the preexisting 128 tests. `git diff --check` passed. No comment suppressions were added.

The final provenance regression first failed with `Received: "Game data is temporarily unavailable. Please try again shortly."` because its stale ID miss was omitted from the error message. After the fix, `bun test packages/commands/test/execute.test.ts` reported five passes and zero failures. The complete pinned suite above then passed.

## Real Cloudflare evidence

The runner uses `alchemy/Test/Bun`, `Cloudflare.providers()`, and `Cloudflare.state()`. It passes an explicit unique stage and omits `dev`. Existing local-mode, stage, credential-isolation, teardown, journal, and API cleanup protections remain active. The account's Cloudflare-backed Alchemy control backend is retained.

The default `bun run test:cloud` now selects a `test-cache-<worktree-hash>-<run-id>` stage and runs the three foundation proofs plus cache cases. `bun run scripts/cloud-test.ts foundation` retains the standalone foundation smoke and its original two-Worker stack. Cleanup remains `bun run test:cloud:cleanup <exact-stage>`.

A cache test stage adds only the fixture resources under `tests/cloud`. The Metaforge Worker exposes controlled JSON, statuses, malformed payloads, held requests, and durable source-call observations. Its fixture DO owns those controls. The cache fixture DO calls the same `makeCacheRpc`, `makeCache`, native storage adapter, schemas, and source reader as production. Its Worker exposes the test-only controls. It uses one cache identity named `environment`.

Fixture time lives under a separate `fixtureTime` storage key and enters through a full Effect `Clock` implementation. Production TTL and cooldown constants are unchanged. Only the fixture source timeout is 15 seconds so cloud requests can hold and release deterministic concurrency cases. This does not establish a production response-time claim. Native `state.abort` proves reconstruction with a changed construction UUID and identical persisted entries. The reset race retains the persistent generation counter and lets an old held source response complete after a newer value is committed.

The stack registers the source Worker before the cache Worker. The cache fixture references that registered resource by logical ID through the resource constructor, which returns the existing registration. It does not evaluate the source Worker implementation in the cache DO. Its URL accessor is bound during construction and read during execution. Fixture POSTs retry only a Cloudflare route-propagation 404, at most four retries spaced 200 milliseconds. Data-read POST 500s and typed source failures fail their checks. Only fixture readiness GETs retry activation failures. The cache and source readiness bound is 30 retries spaced one second. The shared initial foundation readiness hook has a 60-retry bound and a 90-second hook timeout. Readiness also requires a JSON content type, so an HTTP 200 Cloudflare placeholder page cannot satisfy it. Source-call assertions would detect an extra upstream fetch.

The initial successful cache stage was `test-cache-b77ec867-bd07bedb09af`. It passed seven tests with 108 assertions. Its four Workers and three SQLite namespaces were recorded in `resources.json`, destroyed, and independently absent from Cloudflare API lists. Its namespace IDs were `8a553014b9874f3f9bc164bbc6ea75d7`, `f8a4969a417246518e8dd8d3f8f3b830`, and `daf300b712f04dc38dd02de2c842c5a4`. State resource rows and stack output were absent. The final expanded command was `bunx bun@1.3.5 run scripts/cloud-test.ts cache`. Stage `test-cache-b77ec867-704bce611986` passed all eight tests with 148 assertions. This includes all three foundation tests and all five cache tests. Its four recorded Workers were:

```text
arc-tools-bot-test-cache-b77ec867-704bce611986
arc-tools-probe-test-cache-b77ec867-704bce611986
arc-tools-cache-test-cache-b77ec867-704bce611986
arc-tools-metaforge-test-cache-b77ec867-704bce611986
```

Its three recorded SQLite namespace IDs were `e044239423a743c8b30253c1b665c313`, `a477c7d208bd45d79ae6fea1a854314b`, and `d6093c6d7c83407eb02a9650a151f4ae`. The runner reported:

```text
8 pass
0 fail
CLEANUP VERIFIED test-cache-b77ec867-704bce611986: Cloudflare lists 0 Workers and 0 DO namespaces; state entries and output absent; control backend retained
Cloud tests exit 0; cleanup exit 0
```

Cleanup was independently repeated with `bunx bun@1.3.5 run scripts/cloud-test.ts cleanup test-cache-b77ec867-704bce611986`. It again reported zero Workers, zero namespaces, absent state and output, and cleanup exit zero.

The standalone command `bunx bun@1.3.5 run scripts/cloud-test.ts foundation` passed three tests with 25 assertions on stage `test-foundation-b77ec867-a6e81a365399`. The two original foundation Workers and namespace `b277d2c6dae64c769ed8fad036d0b5e3` were destroyed, with API and state-store cleanup verified. The subsequent final combined run also passed these foundation assertions after the larger readiness bound.

Every run retains its non-secret replay journal under `.cloud-tests/<stage>/run.json`, `resources.json`, and `result.json`. The cloud control backend was never included in application cleanup.

Failed attempts remain evidence. All use prefix `test-cache-b77ec867-` and all completed API-verified cleanup.

- `fd5e3866a990` stopped at foundation probe activation before cache tests.
- `f3d2e45057c3` passed foundation but failed cache activation because the source Worker was constructed in the wrong runtime context.
- `74adb36ff92f` returned the diagnostic `DurableObject 'MetaforgeFixtureState' not found`, which identified that fixture construction error.
- `135cb68b30ee` rejected a reference to a not-yet-deployed source Worker during planning. No application resources were created.
- `03f2335e3b68` activated the cache object but failed reads before the fixture Clock supplied its prototype methods explicitly.
- `395ceb30ecb3` passed seven of eight tests. A fixture POST received Cloudflare's route-propagation 404. The subsequent key/flag case passed. The final fixture bounds retries for this response only.
- `6db25d141f9a` passed six of eight tests. Fixture readiness GETs encountered Cloudflare placeholder pages and an internal activation error. Bounded readiness waits increased to 15 retries, and the source observations endpoint activates its fixture object before cache assertions.
- `b6bc2dd030eb` passed every cache case and the raw HTTP and storage foundation proofs. The native alarm retry did not complete within the unchanged 30-second observation window. Its four Workers and all namespaces were destroyed and API cleanup passed.
- `079211e05015` stopped at the shared initial probe after a 15-second route-publication wait. It returned Cloudflare's `Page not found` HTML. The fixture now gives initial publication a bounded 60-second window. No alarm assertion was relaxed.
- The standalone foundation attempt `test-foundation-b77ec867-01eace428990` encountered its existing activation probe's Cloudflare placeholder 404. Its two Workers were destroyed and API cleanup passed. The final shared initial readiness bound is 60 retries.

Local Cloudflare credential environment-variable names were inspected without printing values. The existing default Alchemy profile authenticated and deployed the disposable resources. No Twitch or Discord calls, new agents, pushes, PRs, merges, production deployments, or persistent staging deployments occurred.

## Remaining gates

No unit 2 implementation or cloud-credential blocker remains. Root's independent review and integration are pending. GitHub CI has not been triggered or configured in this unit. Ingress signatures, actual Twitch/Discord operations, direct-response timing and privacy, live-provider grants, release synchronization, and cost remain **NOT VERIFIED** and belong to subsequent units. The fixture's 15-second source timeout provides no evidence for the production Discord budget.

## Design and review boundaries

Model the Domain put cache validity, lease ownership, and completion generations in persisted entries. Boundary Discipline and Type System Discipline put provider decoding in the source adapter and kept SDK/storage types out of commands. Prove It Works required actual cloud storage, source-call observations, native reconstruction, and API cleanup. Build the Lever extended the existing replayable runner rather than adding a new testing framework.

The blocking steps were reading the accepted foundation and choosing the service/data shape. Independent agent work was inapplicable because this unit has one authorized writer. Shared runtime state is isolated by environment and key, with only short storage claims serialized. The smallest safe implementation units were the data/cache contract, command composition, and cloud proof. Commits ran with hooks enabled. No hook configuration or skip setting changed. No root-owned audit file or migration requirement was edited. Root retains independent review and integration ownership.
