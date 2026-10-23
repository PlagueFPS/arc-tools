# Public Website and internal Bot RPC

Website owns browser HTTP so its pages, session cookie, and Twitch redirects share one public origin. Bot owns account policy and credentials behind a Cloudflare service binding. Neither worker forwards frontend requests.

## Ownership and callers

Native TanStack server routes serve `GET /oauth/twitch/enroll`, `GET /oauth/twitch/enroll/status`, and `GET /oauth/twitch/callback`. Website generates independent random browser credentials and OAuth nonces, hashes credentials before RPC, and manages the Secure HttpOnly `__Host-` cookie. It validates query cardinality, size, cookie binding, and denial input before account completion. Responses retain no-store and no-referrer headers. Begin and status have 12-second deadlines; public completion has 16 seconds. Explicit HEAD handlers return 405 without allocating an intent.

The callback dispatches `enroll.` states to session-bound public completion. Other states use operator completion without reading enrollment cookies, retaining the operator completion HTML. Bot exposes these default Worker methods:

- `enrollmentBegin(input)` derives from `TwitchEnrollment.begin`.
- `enrollmentComplete(input)` derives from `TwitchEnrollment.complete`.
- `enrollmentStatus(session)` derives from `TwitchEnrollment.status`.
- `completeOperatorOAuth({ state, code })` derives from `TwitchAccount.completeOAuth` with `operator` omitted. Bot computes the operator secret digest internally.

Bot schema-decodes every RPC input and resolves its existing account or enrollment client per invocation. Durable Object references remain deferred until the invocation's runtime context exists. The service binding authorizes Website as a caller; account policy still validates sessions, nonces, replay, grants, capacity, and readiness.

Website loads `cloudflare:workers` inside its server-only binding accessor and wraps `env.BOT` with `toRpcAsync<Bot>` from `alchemy/Cloudflare/Bridge`. That wrapper decodes Effect error envelopes instead of returning them as successful data. The HTTP adapter reconstructs tagged account errors for 401 session errors and 503 unavailable responses. Missing runtime bindings also produce private 503 responses. Bot resource imports in Website runtime code are type-only.

Bot HTTP retains health, signed Twitch and Discord ingress, and bearer-plus-stage operator setup and status. Browser enrollment and OAuth callback paths return 404 on Bot. CLI operations continue targeting Bot.

The browser status query remains enabled only after hydration, with same-origin credentials, no-store caching, cancellation, and manual refresh. SSG prerenders `/` and `/connect` without querying private sessions or importing the Cloudflare runtime. Standalone `dev:web` renders pages without a binding. Standard Vite SSR configuration externalizes the lazy Cloudflare runtime import; no custom plugin or framework adapter is involved.

## Origins and resources

`ARC_PUBLIC_URL` identifies Bot's webhook and operator origin. `ARC_WEBSITE_URL` independently identifies Website's OAuth origin for both flows. Account runtime configuration names these `webhookOrigin` and `oauthOrigin`; both contribute to its revision. The provider uses the Website callback for authorization links and token exchange.

Deployed Bot configuration remains pinned to Bot's actual self URL. Website receives its configured URL and a host-scoped `Cloudflare.Worker.URL` env binding, then validates their agreement inside handlers. Local stages accept configured HTTPS tunnel origins. Origin values cannot contain credentials, paths, queries, or fragments. Release and local launch configuration require both origins. Configuration flows from Bot to Website's binding without a Bot-to-Website resource dependency.

Local enrollment needs two tunnels or separate hostnames routed to the Bot and Website listeners through named tunnel ingress. Twitch registers the Website `/oauth/twitch/callback`; Discord interactions and EventSub use Bot. Changing either origin changes the account revision and requires renewed authorization.

Non-test stacks instantiate Website after the synthetic-stage early returns. Outputs retain `url` for Bot and add `websiteUrl`. Synthetic stages instantiate no Website, retain their existing resource counts and outputs, and use Bot's origin as a fake OAuth redirect. Their controlled fixture completes grants through internal Bot RPC, not a compatibility HTTP callback.

## Chosen callback design

Keeping operator callbacks on Bot would require flow-specific redirect URIs and token exchange configuration. A single Website callback keeps browser ownership together and preserves one provider redirect URI. Named entrypoints, custom SSR wrappers, a shared secret, and frontend proxies add mechanisms the existing default Worker RPC and native routes do not need.

The raw HTTP journey tests combine Website handlers, real account operations and storage adapter, and signed Bot EventSub ingress. They establish browser binding and readiness policy, not native Cloudflare scheduling or live Twitch grants. Standard and Alchemy-injected builds validate the framework output. Native workerd binding tests establish transport behavior independently of authenticated Alchemy development, which requires Cloudflare credentials.
