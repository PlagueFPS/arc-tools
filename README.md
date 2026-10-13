# ARC tools

ARC Raiders commands for Twitch chat and Discord guild slash commands. One Cloudflare Worker receives Twitch EventSub webhooks and Discord HTTP interactions. Alchemy defines the Effect-native Worker and its SQLite Durable Objects. The ten shared command handlers retain their outputs and event selection rules.

## Local development and verification

Use Bun 1.4.2 and Node 24. CI installs both explicitly. The pinned Vitest 5 and Miniflare versions need Node 22 or later. Local verification runs on Node 24.15.0.

```sh
bun install --frozen-lockfile
bun run build
bun run check-types
bun run lint
bun run test
bun run verify:worker
```

`verify:worker` builds the deployment source with Alchemy's deployment bundler and generated bridges, then runs that bundle in real local workerd through Miniflare. Only external Twitch, Discord, and Metaforge HTTP calls use fixtures. Tests send signed bytes through HttpApi, exercise SQLite transactions and alarms, check channel and guild isolation, restart workerd against persistent storage, check retries, and inspect credential cleanup. This command needs no account credentials and makes no live provisioning requests. Provisioning tests use a local HTTP server.

`bun run dev:worker` starts Alchemy's local development workflow after configuration. For local fixture verification, use `verify:worker` instead. Alchemy keeps infrastructure state locally in `.alchemy`, which is ignored by Git.

## Configuration

Copy `.env.example` to `.env`. Supply Twitch application credentials, the bot user ID, broadcaster IDs, a webhook secret, the Discord application ID, and the application's Ed25519 public key. `TWITCH_WEBHOOK_SECRET` must contain 10 to 100 ASCII characters. Keep environment files, application secrets, interaction tokens, and Alchemy state out of source control.

The runtime acquires Twitch app access tokens with client credentials on demand and caches them until shortly before expiry. A 401 invalidates the cached token and retries acquisition once. No refresh token, token database, or additional token actor is required. `DISCORD_BOT_TOKEN` is only used by the provisioning CLI.

## Deploy and provision

These commands write to real accounts. Local tests do not run them.

1. From `apps/worker`, run `bunx alchemy profile edit --add Cloudflare` and select the account with Workers and Durable Object deployment permissions. CI deployments use `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` instead. Fill the bot configuration in the repository root `.env`, which the stack and provisioning scripts load explicitly. See [Alchemy Cloudflare setup](https://alchemy.run/cloudflare/setup/).
2. From `apps/worker`, run `bunx alchemy deploy alchemy.run.ts --stage production`. The stack provisions the Worker and both SQLite Durable Object namespaces and prints its URL.
3. Set the Discord application's Interactions Endpoint URL to `https://<worker>/webhooks/discord` in the developer portal. Discord verifies the endpoint with a signed PING. Install the application into the intended guilds with the `applications.commands` OAuth scope.
4. Run `bun run provision:discord`. This explicitly bulk replaces the application's global slash command list with the registry's ten commands. The payload enables guild installation and guild contexts. Ordinary Discord messages are unsupported. There is no Gateway connection or runtime registration loop.
5. Set `TWITCH_CALLBACK_URL` to the deployed HTTPS URL ending in `/webhooks/twitch`. Obtain the Twitch bot and broadcaster authorization grants described below. Run `bun run provision:twitch` to reconcile the subscriptions.

Twitch webhook subscriptions use an app access token. Authorize the bot user for `user:read:chat`, `user:write:chat`, and `user:bot`. Each broadcaster must grant `channel:bot`, or the bot must have the moderator role as allowed by Twitch's app-token chat rules. The authorizations must belong to the same Twitch application as `TWITCH_CLIENT_ID`. The bot and broadcaster IDs must identify the users who granted those permissions. Runtime client credentials do not create user authorization grants. See [Twitch bot authentication](https://dev.twitch.tv/docs/chat/authenticating/).

Twitch reconciliation follows every list cursor. It matches type, version, broadcaster, bot user, webhook transport, and callback URL. It retains one enabled or pending matching subscription, deletes matching duplicates or revoked entries, and creates a missing subscription. Other bots, transports, and callbacks remain outside its ownership. Reconciliation is explicit and does not run in the Worker.

If reconciliation fails partway through, rerun the command. Earlier channels may already have changed because Twitch does not provide an atomic transaction across subscriptions. Reconciliation keeps existing subscriptions by ID, including IDs repeated across list pages.

The list API does not return a subscription's signing secret. Keeping an enabled subscription therefore cannot detect a changed `TWITCH_WEBHOOK_SECRET`. To rotate it, update the deployed Worker secret and run `bun run provision:twitch --recreate`. This explicitly recreates subscriptions matching the configured bot, broadcasters, and callback. Coordinate these steps because old signatures fail until the subscriptions use the new secret. See [Twitch subscription creation](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription).

## Request and job behavior

Twitch signatures cover the message ID, timestamp, and exact body bytes. The Worker verifies HMAC-SHA256 with Web Crypto, checks a ten-minute freshness window and one-minute future allowance, and validates the subscription and bot condition. Authenticated challenges receive plain text. Notifications and revocations receive 204. Unknown commands and the bot's own messages do not activate a channel object. Replies use Helix's parent message ID, enforce the 500-character limit, and check both `is_sent` and `drop_reason`. See [Twitch webhook handling](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/).

Discord signatures cover the timestamp and exact body bytes. The Worker verifies Ed25519, checks a five-minute freshness window, validates the application and slash options, and responds to PING with PONG. A supported guild command receives a public deferred acknowledgement after durable acceptance. Unknown commands and direct messages receive immediate ephemeral errors. Results and command errors edit the same public original response and disable mentions. Discord fixes visibility when it acknowledges an interaction. See [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

Ingress limits raw bodies to 64 KiB before buffering. The pinned Effect Web Request adapter does not apply its size reference to `arrayBuffer`, so ingress also reads and limits the byte stream under `MaxBodySize`.

`BotWork` is a schema-derived Twitch or Discord union. Each channel or guild owns its pending jobs, transient credentials, and delivery tombstones. Acceptance and `Alchemy.makeCallback` scheduling commit in the same SQLite storage transaction before the Worker acknowledges the request. Concurrent duplicates return the same acknowledgement without scheduling another job.

Persisted jobs move through `execute`, `reply`, and `terminal`. Each attempt commits before external work. Rendered text persists before delivery, so time-sensitive command output remains stable during outbound retries. Callbacks carry only a job key. Alchemy records recovery wakes before running callbacks. There is no permanent processing state or in-memory job queue.

Jobs allow five attempts and a ten-minute deadline. Discord's deadline is also bounded by the signed timestamp plus fourteen minutes, before its fifteen-minute token lifetime. HTTP calls time out after five seconds and command execution after eight seconds. Transient transport, rate-limit, and server failures use durable backoff and respect bounded `Retry-After` and Twitch's `Ratelimit-Reset`. Successful and terminal jobs discard command payloads and interaction tokens. Tombstones last 24 hours and receive one cleanup callback. The scheduler stops when no callbacks remain. No cron or permanent polling loop runs.

Twitch external sends have a crash window between remote success and local completion. A crash in that window can repeat a reply. This system does not promise exactly-once Twitch sends. Discord retries edit the same original response, which converges to one message.

## Packages

`apps/worker` owns ingress, schemas, durable jobs, platform HTTP clients, provisioning, infrastructure, and workerd verification. `packages/commands` owns the registry and ten handlers. `packages/arc-data` owns Metaforge requests and schemas. `packages/utils` owns command text utilities. `packages/testing` owns the fixture HTTP client for shared tests, including assembled URL parameters.
