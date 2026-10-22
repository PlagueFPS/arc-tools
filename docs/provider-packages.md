# Provider package boundaries

The bot application owns command ingress, tenant execution, deadlines, replay protection, delivery recovery, and Cloudflare resource declarations. Provider packages own authentication and setup behavior. A package extraction does not create another deployment or account store.

## Public command documentation

Import `@arctools/commands/catalog` for descriptions, argument definitions, usage, and example invocations. This export has no handler, Effect, Alchemy, or data-service dependency.

```ts
import { commandCatalog } from "@arctools/commands/catalog";

const sell = commandCatalog.find((command) => command.name === "sell");

sell?.example.twitch;
sell?.example.discord;
```

The examples are `!sell sensors` and `/sell item:sensors`. Discord includes its named slash option. Examples contain usage only. They do not run commands or include example replies.

The catalog is the source for recognized command names and Discord registration metadata. `@arctools/commands/schemas` supplies runtime validation. The package root supplies execution. The handler map must cover every catalog command and cannot add an unlisted command.

## Discord installation and publication

`@arctools/discord/install` exports `guildInstallUrl({ applicationId })`. It returns an Effect that validates the public application ID with Schema and builds a guild installation link with the `bot` and `applications.commands` scopes, guild installation context, and zero additional bot permissions. Invalid IDs fail with `DiscordInstallError`. The export supports browsers with Effect and imports no server code.

`@arctools/discord/server` supplies the desired command manifest, its canonical hash, release readiness checks, and synchronization. Synchronization retains stage, revision, and manifest fencing, rate handling, and verified readback. Operator and release scripts use this export. Installing into a guild does not register commands; the release workflow publishes global commands for the application.

## Twitch account ownership

`@arctools/twitch/server` supplies account service contracts and schemas. `@arctools/twitch/cloudflare` supplies storage, RPC, credential maintenance, and runtime construction. Test fixtures and controlled provider construction use explicit testing exports.

The `TwitchAccountDO` declaration stays in `apps/bot/src/twitch.ts`, under the resource name `TwitchAccount`. The environment object remains named `environment`. Its indexed layout stores broadcaster records separately from shared credentials and send state. It initializes a fresh keyed account and ignores the old `account:v1` snapshot. One owner coordinates grants, OAuth intents, confirmed EventSub subscriptions, credentials, send attempts, and rate reservations across channel tenants.

A tenant asks the account to dispatch a persisted part with its original deadline and stable attempt ID. It does not refresh credentials, create subscriptions, reserve provider capacity, or send through a second path.

Public enrollment uses this same owner. Its HTTP routes remain on the bot origin. The website can navigate to the enrollment entry point without handling an operator secret, Twitch client secret, or access token. See the operator guide for setup and enrollment requirements.

The [channel storage design](twitch-channel-storage.md) describes the first unit of issue #20, its fresh-start authorization steps, and the remaining work before removing the admission ceiling.

## Shared HTTP policy

`@arctools/utils/http` owns provider request limits, timeouts, redirect handling, response decoding, and digest helpers. It is separate from the ordinary utils export. Provider packages share this implementation without importing bot application source.

## Dependency checks

Browser bundle tests inspect the catalog and Discord install entry points for server dependencies. Existing account, provider, subscription-proof, deadline, registration, and HTTP tests exercise behavior across the package boundaries.

The repository checks run from the root in this order:

1. `bun run typecheck`
2. `bun run lint`
3. `bun run fmt`
4. `bun run test`

The local verification skill drives signed Discord requests through workerd. Its fixture identities do not establish live provider authorization or delivery. Cloud and live-provider verification retain their separate preconditions.
