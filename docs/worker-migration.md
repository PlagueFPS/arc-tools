# Worker migration

This migration keeps the ten ARC command handlers and replaces both persistent bot clients with one Cloudflare Worker. Twitch receives EventSub chat notifications. Discord receives HTTP slash interactions. The user chose slash commands only so Discord does not require a Gateway connection.

## Completion criteria

The compiled Worker must run in workerd and accept signed requests for both platforms. Verification must cover Twitch challenges, Discord PING, invalid signatures, stale requests, tenant isolation, duplicate delivery across restart, durable job execution, and outbound command replies. External Twitch, Discord, and Metaforge calls can use local fixtures. The real HttpApi ingress and Durable Objects must run.

Build, type checking, lint, and the shared command tests must pass. Alchemy must define the Worker and its Durable Objects. Subscription and command provisioning must have runnable commands and documented authorization requirements. Removing the old apps must remove the bot SDK imports and token database machinery.

Live Twitch, Discord, and Cloudflare integration requires account credentials. This run does not deploy resources or register commands against a live application.

## Baseline

`bun install --frozen-lockfile`, `bun run test`, and `bun run check-types` passed before changes. The test run contains 122 passing tests. Commands account for 60 tests, ARC data for 18, utilities for 27, Discord adapters for 12, and Twitch token decoding for 5.

The existing HTTP test adapter reads `request.url` without the separately assembled query parameters. The migration must correct that test boundary before relying on lookup coverage. The existing command output and event selection semantics remain the compatibility target.

## Workflow

1. Map current behavior and verify platform transport constraints.
2. Compare Effect-native Alchemy objects with native Cloudflare classes running Effect.
3. Prove the selected deployment bundle runs in workerd before implementing webhook features.
4. Implement authenticated ingress, per-tenant durable work, and platform reply clients.
5. Add explicit provisioning and setup instructions. Remove the persistent clients and their database configuration.
6. Run the complete local checks and independent review. Fix demonstrated failures and rerun affected checks.

## Throughput checkpoint

The blocking steps are platform feasibility, preserved command behavior, and a runnable Worker bundle. Read-only behavior mapping and competing designs run independently. One code owner writes the coupled migration. Channel and guild objects own separate durable state. This avoids concurrent edits to the dependency graph and prevents tenants from sharing a work queue.

The dependency upgrade, generated Worker bridges, and removal of both persistent apps form one deployable replacement. One atomic PR keeps that transition reviewable without temporary compatibility code. Independent reviews ran before publication. The parent took the final fix round after a fresh delegate failed at model capacity.

## Final local verification

The parent ran the final checks on Bun 1.4.2 and Node 24.15.0 after the review fixes.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed without lockfile changes. |
| `bun run build` | Five tasks passed. Four unchanged shared builds used Turbo cache. |
| `bun run check-types` | Nine tasks passed. Eight unchanged tasks used Turbo cache. |
| `bun run lint` | Biome checked 80 files without fixes. |
| `bun run test` | 118 tests passed. The 106 retained shared tests used valid Turbo cache entries. Twelve provisioning and HTTP tests ran afresh. |
| `bun run verify:worker` | All 22 workerd checks ran and passed against the rebuilt deployment bundle. |
| `git diff --check` | Passed. |

The new regression tests failed against the old code before the fixes. They reproduce overlapping subscription pages, unsupported pagination parameters, ignored rate-limit reset headers, and a valid case variant of the bearer token type. The workerd reset test inspects the persisted callback wake time without waiting for the external rate bucket.

The old transport-specific tests were removed with their SDK adapters. The retained shared test count increased from 105 to 106 because the fixture query correction gained a lookup case. The new Worker has 12 HTTP and provisioning tests plus 22 workerd checks. See [review findings and responses](worker-review.md).

Local verification makes no live account writes. Deployment, authorization grants, application installation, and endpoint registration still need account setup. The README describes those steps and the possible duplicate Twitch reply after a crash during delivery.

## Principles that shaped the change

| Principle | Concrete choice |
| --- | --- |
| Model the Domain and Foundational Thinking | Separate Twitch and Discord work in a schema union and persist execute, reply, or terminal jobs. |
| Type System Discipline and Boundary Discipline | Decode raw network data and stored jobs at the boundary, retaining branded tenant IDs. |
| Make Operations Idempotent | Deduplicate deliveries and subscription IDs, and edit Discord's original response during retries. |
| Separate Before Serializing Shared State | Give each channel and guild its own Durable Object and use one migration code writer. |
| Laziness Protocol | Delete the persistent client apps and singleton runtime instead of adding compatibility layers. |
| Exhaust the Design Space | Compare native Cloudflare queues with Alchemy callbacks and test the selected generated bridges. |
| Build the Lever and Prove It Works | Commit a repeatable workerd verification command that runs without account credentials. |
| Sequence Work into Verifiable Units | Prove the runtime bundle first, then webhook behavior, provisioning, and recovery. |
| Fix Root Causes and Test Behavior, Not Implementation | Reproduce review failures through HTTP and workerd before correcting header parsing and subscription identity. |
| Encode Lessons in Structure | Put Worker verification and explicit runtime versions in CI. |

## Sources

- [Alchemy Workers](https://alchemy.run/cloudflare/compute/workers/).
- [Alchemy Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/).
- [Alchemy Effect HTTP API](https://alchemy.run/cloudflare/apis/effect-http-api/).
- [Twitch bot authentication](https://dev.twitch.tv/docs/chat/authenticating/).
- [Twitch webhook handling](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/).
- [Twitch chat replies](https://dev.twitch.tv/docs/api/reference/#send-chat-message).
- [Discord HTTP interactions](https://docs.discord.com/developers/interactions/overview).
- [Discord response deadlines](https://docs.discord.com/developers/interactions/receiving-and-responding).
- [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/).
