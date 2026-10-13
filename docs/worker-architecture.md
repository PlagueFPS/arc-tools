# Worker architecture

## Caller behavior

Twitch sends signed EventSub requests to `POST /webhooks/twitch`. A verification request receives the raw challenge. A supported chat command receives an empty acknowledgement after durable acceptance. The channel object executes the command and sends a threaded Helix reply.

Discord sends signed interactions to `POST /webhooks/discord`. PING receives PONG. A supported guild command receives a public deferred response after durable acceptance. The guild object executes the command and edits the original response. Unknown commands and unsupported direct messages receive immediate ephemeral errors. Execution errors after a public deferral remain public because Discord fixes visibility during acknowledgement.

The command registry remains the only list of supported commands and slash options. Provisioning derives Discord registration from that registry. Twitch provisioning reconciles subscriptions by broadcaster ID, bot ID, callback URL, and transport.

## Data and ownership

`BotWork` is a schema-derived discriminated union. A Twitch job carries broadcaster ID, chat message ID, command name, and input. A Discord job carries guild ID, application ID, interaction ID, interaction token, command name, and input. Platform metadata cannot be mixed. Parse external requests and stored values once at their boundaries.

Each Twitch channel and Discord guild has a named Durable Object. A tenant owns pending jobs, delivery tombstones, and transient credentials. No global command queue exists. Twitch application credentials use on-demand client-credentials tokens. They do not require shared rotating user refresh tokens or Turso.

Acceptance and scheduling commit in one storage transaction. Duplicate jobs do not schedule more work. A callback loads pending work, records an attempt, executes the registry handler, sends the response, and removes temporary credentials. A completed tombstone prevents ordinary retries from repeating the reply. Retry counts and deadlines bound failing work. Expiration work removes tombstones and pending credentials and stops when no work remains.

Twitch sends cannot be exactly once across a crash between remote success and local acknowledgement. Discord edits the same original message on retries, so repeating a successful edit converges to the same message. Document this difference.

## Runtime modules

One app owns the Worker, schemas, signature checks, platform HTTP clients, Durable Objects, provisioning scripts, and workerd verification. Keep these modules flat. Keep infrastructure definitions in `alchemy.run.ts`. Keep existing shared ARC command and data packages.

Use Effect HttpApi raw handlers for signature verification before decoding JSON. Use Web Crypto for HMAC-SHA256 and Ed25519. Verify timestamp freshness and expected application, bot, subscription, and tenant identifiers. Ignore Twitch bot messages and unknown commands before activating an object.

## Design comparison

The native Cloudflare candidate uses a custom SQLite queue and native alarms. It exposes scheduling, atomic acceptance, retry recovery, and expiry rules to application code. Its sample queue separates job insertion from alarm scheduling and cannot recover jobs left in its processing state. Those samples are not suitable for implementation.

The selected base uses Alchemy Effect-native Worker and Durable Object definitions with typed RPC and durable callbacks. Alchemy owns alarm recovery. The application still owns bounded retries, deadlines, job state, and duplicate semantics. A second reviewer selected this base independently. The first runtime gate passed without account credentials. The generated deployment bundle ran HttpApi routing, durable acceptance, duplicate suppression, and callback execution in local workerd. The parent independently reran that test. Native classes are unnecessary for the verified runtime.

The completed sketch adds explicit execute, reply, and terminal job states. Store the rendered command output before outbound delivery. A retry sends the saved output rather than recalculating a time-sensitive event answer. Callback payloads contain job keys rather than temporary interaction credentials.

The useful graft from the native candidate is direct storage inspection in local tests. It lets verification inspect actual persisted jobs and tombstones rather than infer durable state from adapter mocks. The native queue implementation itself is rejected.

Raw authentication does not require abandoning HttpApi. Its `handleRaw` operation supplies the request without automatic payload decoding. The design comparison must test actual integration rather than infer compatibility from framework names.

## Verification

Run the deployment bundle in Miniflare with SQLite Durable Objects. Stub only Twitch, Discord, and Metaforge HTTP calls. Send signed raw requests through the real Worker. Verify handshake bodies, authentication failures, accepted command responses, tenant routing, threaded replies, deferred edits, duplicate suppression after restart, retry exhaustion, and expiry cleanup.

Build, type checking, lint, preserved command tests, and the Worker verification must pass. Run provisioning against local HTTP fixtures to verify request shape, pagination, and reconciliation. Do not deploy or register live resources during local verification.
