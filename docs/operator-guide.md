# Operate ARCToolsBot

## Prepare an environment

1. Install Bun 1.4.3 and run `bun install --frozen-lockfile` at the repository root.
2. Use the dedicated test Twitch and Discord applications for local development, and the dedicated production applications for `prod`. Use separate applications for staging if it runs alongside local development. Production uses a dedicated sender and an explicit channel-login list.
3. Copy `.env.example` to an ignored environment file, such as `.env.local` or `.env.staging`. Replace public placeholders and enter secrets through a private editor or your secret manager. Set file permissions with `chmod 600 .env.local`. Never commit the filled file.
4. Select your Cloudflare account and Alchemy authentication profile. `bunx --no-install alchemy profile list` and `bunx --no-install alchemy profile current` inspect profiles. If needed, use `alchemy profile create` and `alchemy profile edit` through the same `bunx --no-install` prefix.

An Alchemy profile selects provider authentication. A stage selects the application's resources and identities. They are independent. Pass `--profile default` or another existing profile explicitly. The stack requires `ARC_STAGE`, `APPLICATION_STAGE`, and `--stage` to agree. Its supported application stages are `local-<name>`, `staging`, and `prod`; disposable tests select their own unique `test-...` stage. Resident PR previews derive a stable `test-tenant-<8hex>-<12hex>` stage from the repository and PR number. Both test paths use synthetic identities.

Keep the Cloudflare state control backend. It stores deployment state separately from each application's resources. Disposable test cleanup destroys the selected application stage and verifies its absence while retaining that backend.

## Configure bindings

The stack reads these names. The worker captures ordinary configuration and uses `Config.Redacted` for application secrets.

| Public name                      | Value                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARC_STAGE`, `APPLICATION_STAGE` | The same explicit stage.                                                                                                                                                                                                         |
| `ARC_ENVIRONMENT`                | `personal` or `bot` for local/staging; `production` for prod.                                                                                                                                                                    |
| `ARC_BUILD_REVISION`             | The deployed Git revision. Health and registration compare it exactly. Default is `unreleased` for development.                                                                                                                  |
| `ARC_BOT_URL`                    | Bot webhook and operator HTTPS origin. Deployed stages pin it to the actual Bot Worker URL. Local stages use the Bot tunnel origin.                                                                                              |
| `ARC_WEBSITE_URL`                | OAuth origin for both flows. Defaults to `http://localhost:3000` outside production; that exact origin is the only HTTP exception. HTTPS overrides remain supported. Production requires the actual HTTPS Website Worker origin. |
| `TWITCH_SENDER_KIND`             | `personal` in personal mode; `bot` in bot or production mode.                                                                                                                                                                    |
| `TWITCH_SENDER_LOGIN`            | Lowercase sender login. Setup resolves it to an ID.                                                                                                                                                                              |
| `TWITCH_CHANNEL_LOGINS`          | Comma-separated lowercase manual logins. Personal mode requires exactly the sender login. Bot mode requires a nonempty configured set and supports up to 32 desired channels across configured and public memberships.           |
| `TWITCH_CLIENT_ID`               | This environment's Twitch application.                                                                                                                                                                                           |
| `DISCORD_APPLICATION_ID`         | This environment's Discord application.                                                                                                                                                                                          |
| `DISCORD_PUBLIC_KEY`             | That application's 64-hex-character Ed25519 verification key.                                                                                                                                                                    |
| `CLOUDFLARE_ACCOUNT_ID`          | Target Cloudflare account.                                                                                                                                                                                                       |
| `ALCHEMY_PROFILE`                | Optional authentication-profile selection when no explicit `--profile` is passed.                                                                                                                                                |

Inject `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_BOT_TOKEN`, and `OPERATOR_SECRET` privately. Cloudflare API-token authentication additionally uses `CLOUDFLARE_API_TOKEN`. The Discord bot token remains required for CLI command registration and drift checks even though interaction replies use the incoming HTTP response.

Pinned Alchemy has no application-secret `set` command. Its CLI accepts `--env-file`; this repository uses its default environment/config provider. Without that flag, exported process values override `.env`. An explicit `--env-file` takes precedence over process values for names in that file. Put public configuration in the file and inject secrets through your secret manager's environment wrapper, or use a protected ignored file for both. Do not put secret values in command arguments, shell history, output logs, or chat.

Bun's `--env-file` loads the environment for the operator scripts, which do not accept Alchemy's flag. Exported process values take precedence over Bun's file values. The local shortcuts below explicitly give `.env.local` values precedence, including application secrets. Names absent from the file fall back to the environment, so secret-manager wrappers still work. CLI profile credentials do not supply application secrets. Synthetic provider endpoints and test control routes cannot be selected for personal, bot, or production environments.

## Develop with local workerd

Start from `.env.example`. Set both stage fields to `local-yourname`, `ARC_ENVIRONMENT=bot`, and `TWITCH_SENDER_KIND=bot`. Set `TWITCH_SENDER_LOGIN` to the dedicated test bot and `TWITCH_CHANNEL_LOGINS` to the test broadcaster channels. Use the test portal applications. Set `ARC_BOT_URL` to the Bot HTTPS tunnel origin. Website OAuth defaults to `http://localhost:3000`; omit `ARC_WEBSITE_URL` or set it to that exact value. Origins must omit paths, queries, fragments, and credentials.

For each new tunnel session, configure `ARC_BOT_URL` in the repository root's protected `.env.local`. Only Bot needs an HTTPS tunnel. Twitch returns the browser to Website on your computer; Twitch's servers send EventSub requests to Bot. Install [`cloudflared`](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) on your PATH. In terminal 1, start a Quick Tunnel to the Bot listener:

```bash
bun run tunnel --url http://localhost:1337
```

Copy the printed HTTPS origin into `ARC_BOT_URL`. The tunnel can start before Bot. Keep it running. In terminal 2, start development:

```bash
bun run dev:local
```

Alchemy prints the Bot HTTP address. If its port differs from 1337, restart the tunnel with that exact address, update `ARC_BOT_URL`, and restart development. Website listens on strict port 3000 without an explicit host override. The shortcut prints these public routes for you to paste into the corresponding portal applications:

- Discord interactions endpoint is `https://YOUR_BOT_ORIGIN/interactions/discord`.
- Twitch EventSub callback is `https://YOUR_BOT_ORIGIN/webhooks/twitch`.
- Twitch OAuth redirect is `http://localhost:3000/oauth/twitch/callback`.

If the Bot tunnel host changes, update the Discord interactions endpoint manually. The localhost Twitch OAuth redirect stays the same. Editing an origin does not change a portal. Setup uses the configured EventSub callback when it repairs subscriptions.

In terminal 3, register Discord commands and run Twitch setup:

```bash
bun run setup:local
```

Setup runs the existing Discord sync with `--wait`, then the existing operator setup command. A failed sync stops setup. Registration checks the exact stage, revision, ready status, and manifest hash before it changes commands. OAuth links print last. Keep setup output private because those links contain one-time OAuth state. Open each link yourself as the intended identity, then repeat `bun run setup:local` after completing grants if setup requests it. The shortcut does not open a browser.

Use `bun run status:local` for Twitch status and Discord drift at the selected revision. Use `bun run sync:discord:local` to repeat only Discord synchronization with readiness waiting.

All four shortcuts read `.env.local` themselves and accept no additional arguments. They require matching `local-*` stage fields and either a personal sender in its own single channel or a dedicated bot profile. Every child receives the resolved file values, even when stale values remain exported in the shell. `ARC_BUILD_REVISION` defaults to `unreleased` only when absent from both sources. If you set it, use the same nonempty revision for development and setup. Set `ALCHEMY_PROFILE` in the file or environment to select a profile, or omit it to use Alchemy's configured selection. Restart development after changing the file. The generic `dev`, `deploy`, `ops`, and `sync:discord` commands retain their explicit release flags.

Inspect `GET /health` at the local address. It returns `status: "ready"`, the stage, revision, and command manifest hash. This proves application build identity, not provider authorization. Stop development with Ctrl+C. The integration suite also uses local workerd with isolated file state.

A placeholder HTTPS origin can exercise health and signed PING locally without a tunnel or provider calls. It cannot receive live webhooks or OAuth redirects.

## Retire personal-sender setup

The dedicated test and production applications replace personal-sender configuration. Personal mode remains available for own-channel use, but is no longer the default development setup.

| Previous setup                                                                      | Dedicated application setup                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your personal login as `TWITCH_SENDER_LOGIN` and both mode fields set to `personal` | Use the environment's bot login. Set both mode fields to `bot` for local/staging. Production uses `ARC_ENVIRONMENT=production` and `TWITCH_SENDER_KIND=bot`.                                                                                       |
| One personal account authorizing combined sender and broadcaster scopes             | Authorize sender scopes as the bot. Authorize `channel:bot` as each broadcaster, including your personal account if you install the bot in your channel.                                                                                           |
| Hand-generated user tokens, refresh commands, or a local `tokens.json`              | The current runtime uses neither user-token files nor operator token-refresh commands. Remove obsolete copies from this project's private setup after switching. Keep the application secrets in the protected environment file or secret manager. |
| Repeating grants and Discord registration every session                             | With unchanged configuration and retained local storage, use `dev:local` and `status:local`. Run `setup:local` for initial setup or grant/subscription repair. Use `sync:discord:local` for command drift.                                         |
| Operator setup for every new public broadcaster                                     | Prepare the bot sender and configured channels through setup. Additional broadcasters use Website's public enrollment flow.                                                                                                                        |

When migrating an existing protected file, replace its mode fields, sender login, and Twitch and Discord application credentials with the test application's values. Keep at least one configured broadcaster. Use the production credentials only in the production environment. Grants from the old Twitch application do not authorize the new client ID. Run setup and complete the new application's grants before retiring the old setup. Revoke an old personal-application grant only after confirming that no remaining consumer needs it.

Dedicated applications do not remove Twitch consent. The bot still grants `user:read:chat`, `user:write:chat`, and `user:bot`; each broadcaster grants `channel:bot`. See [Twitch cloud chatbot authentication](https://dev.twitch.tv/docs/chat/authenticating/). App-token creation, validation, and subscription repair are handled by the account runtime. Configuration changes, lost local storage, or revoked grants can require authorization again.

## Exercise public enrollment through a local tunnel

Use a separate real Twitch application and dedicated test bot account. A real test application uses ordinary provider credentials and `ARC_STAGE=local-yourname`. Reserved `test-*` stages are synthetic fixtures with fixed IDs and credentials. They cannot exercise live public enrollment.

Use the [local development setup](#develop-with-local-workerd) and the dedicated test application. Production must configure `ARC_WEBSITE_URL`; nonproduction defaults to localhost. Register the Website callback for both OAuth flows. Keep `ARC_STAGE` and `APPLICATION_STAGE` on the same `local-*` value. Changing identity, secrets, or either origin changes the account revision and requires renewed grants and setup. Stored public memberships survive, but their grants must be renewed.

1. Copy `.env.example` to the ignored, protected `.env.local`. Select `ARC_ENVIRONMENT=bot` and `TWITCH_SENDER_KIND=bot`. Supply the test bot login, at least one configured channel login, and separate Twitch and Discord application credentials privately. Keep all Discord bindings because the full Bot and `setup:local` require them.
2. Set `ARC_BOT_URL` to your Bot HTTPS tunnel origin. Keep `ARC_WEBSITE_URL` absent or set to `http://localhost:3000`. Use `bun run tunnel --url http://localhost:1337` with the actual Bot port. For an existing locally managed named tunnel, `bun run tunnel run <name>` uses its configured routing and keeps the hostname stable.
3. Run `bun run dev:local`. Tunnel the **Bot** listener printed by Alchemy. Open Website at `http://localhost:3000` on the computer running the browser. Port 3000 must be free; startup fails instead of silently choosing another port. Native Foldkit SSR development renders pages in Node without the Bot binding, including `dev:web` and the documented Alchemy dev host. Account operations that need that binding return private unavailable responses. Use the generated Website Worker in a binding-capable runtime for complete OAuth verification. Leave existing user processes alone.
4. Register exactly `http://localhost:3000/oauth/twitch/callback` as an OAuth redirect on the **test Twitch application**. Configure the separate Discord application's interactions endpoint as printed by `dev:local`. Portal edits are manual and require the application's operator. See [Twitch application registration](https://dev.twitch.tv/docs/authentication/register-app/).
5. Run `bun run setup:local` privately. Authorize the sender link as the dedicated test bot and each configured broadcaster link as its broadcaster. Repeat setup after grants complete. The sender requires `user:read:chat`, `user:write:chat`, and `user:bot`. Broadcasters require `channel:bot`. Use `bun run status:local` to inspect setup and subscription state. If Discord registration is unavailable, the existing `ops setup` CLI can prepare Twitch alone with the same local stage and HTTPS endpoint, as described below.
6. In a broadcaster browser session, open `http://localhost:3000/oauth/twitch/enroll`. Authorize `channel:bot` as that broadcaster. Keep the session in the same browser through the callback. Open `/oauth/twitch/enroll/status` on that origin. It reports `pending` until the alarm repairs the subscription and confirmed enabled evidence arrives, then `ready` with the broadcaster login. A webhook verification challenge alone leaves it pending.

Keep both workers and the Bot tunnel running for alarm repair and callbacks. A changed Bot hostname requires `ARC_BOT_URL`, the Discord portal update, restart, and renewed setup. Staging dedicated bots use `ARC_ENVIRONMENT=bot` and the deployed Bot origin in `ARC_BOT_URL`. Staging OAuth also defaults to localhost. That redirect requires a Website instance on the browser user's computer connected to the intended Bot through a service binding; a deployed staging page alone does not supply that local application. For onboarding through the deployed staging Website, explicitly configure its HTTPS origin instead. Tunnel overrides remain restricted to `local-*`, and Alchemy development still rejects `prod`.

Live grants, portal edits, remote tunnel creation, deployment, and chat sends require separate authorization. Controlled tests establish protocol and state behavior. They do not establish live Twitch onboarding or tunnel reachability.

## Deploy and register a release

Set both stage fields to `staging` and use the staging portal applications. Set `ARC_ENVIRONMENT=bot` and `TWITCH_SENDER_KIND=bot` for the dedicated staging bot. Set `ARC_BUILD_REVISION` to the intended commit. Configure the deployed Bot origin before release. Staging defaults to the localhost OAuth redirect; an HTTPS Website override supports remote browser onboarding. Production requires the deployed HTTPS Website origin. Register the chosen Website callback. The stack retains `url` as the Bot operator endpoint and adds `websiteUrl` for browser entry. For production, set both stage fields to `prod`, `ARC_ENVIRONMENT=production`, and `TWITCH_SENDER_KIND=bot`; supply the dedicated sender and manual channel logins.

```bash
bun run build
bun run typecheck
bun run lint
bun run fmt
bun run test
bun run deploy --stage staging --profile default --env-file .env.staging --yes
```

Keep `ARC_BOT_URL` equal to the exact working deployed origin. Do not guess a workers.dev hostname or overwrite the existing production value. Missing `ARC_BOT_URL` caused the first production runtime failure. Setting the exact URL and redeploying repaired it. For a new cloud service, read the actual stack output, configure that exact origin, and redeploy before registration. Inspect `/health` and compare stage, revision, and manifest hash.

The Release workflow accepts only explicit `staging` or `prod` and an application ID. Successful CI on a `main` push calls the same workflow with the exact checked SHA and repository variable `PROD_DISCORD_APPLICATION_ID`. Manual production dispatch must select `main`; staging dispatch uses its existing environment. Both paths serialize by application ID and require the environment's `DISCORD_APPLICATION_ID` to match the input. Automatic releases recheck the current main head after acquiring the lock and immediately before deployment. The workflow checks out the exact revision, deploys it, and registers the global manifest. Registration checks the deployed stage, revision, ready status, and hash before and after operations. It compares all global commands with full localization dictionaries and reads back an overwrite. Before deployment, an authenticated read verifies Discord application access. A partial release leaves the deployment running and reports incomplete registration. Use sync-only recovery below to repair commands without redeploying.

Follow [the CI/CD bootstrap guide](ci-cd-bootstrap.md) before enabling automatic releases. Populate the existing bot application variables and secrets privately in `prod` and `staging`. Preserve the current portal callbacks and Twitch grants. Remote CI/CD activation remains UNVERIFIED until bootstrap, environment configuration, and real workflow runs succeed. See [the CI/CD verification record](verification/alchemy-cicd.md) for local evidence and rollout limits.

Keep `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_BOT_TOKEN`, `OPERATOR_SECRET`, and `CLOUDFLARE_API_TOKEN` in their selected GitHub environment. CI forwards these five secret names to Release explicitly. Release declares each name required and rejects empty values before dependency installation or API calls. A missing-value failure reports secret names only. Manual dispatch resolves the same environment secrets directly.

For manual registration or repair, export the actual deployed origin and the exact revision that just deployed. The protected file must agree with them. If you deployed the current checkout:

```bash
export ARC_BOT_URL=https://YOUR_DEPLOYED_ORIGIN
export ARC_BUILD_REVISION="$(git rev-parse HEAD)"
bun --env-file=.env.staging run sync:discord --stage staging --endpoint "$ARC_BOT_URL" --revision "$ARC_BUILD_REVISION" --wait
```

The shell must already export `ARC_BOT_URL` and `ARC_BUILD_REVISION` for those argument expansions. Alternatively replace the two arguments with the actual public origin and exact commit. Bun loads the script's application ID and bot token from the protected file or environment. `--wait` bounds readiness polling to 60 attempts over at most 60 seconds; it does not bypass the revision fence. Serialize manual registration with releases for the same application.

### Repair command registration without deployment

Read the selected Worker's `/health` response and record its exact full revision. In the **Release** workflow, select the stage and application ID, set **operation** to `sync`, and supply that revision. For production, dispatch from `main`. The revision must belong to main history. Recovery uses the same application lock as full releases and checks out the requested revision.

```bash
gh workflow run release.yml --ref main \
  -f stage=prod -f application_id='<production application ID>' \
  -f operation=sync -f revision='<full deployed SHA>'
```

Recovery skips deployment and requires only the Discord bot token among the release secrets. It verifies the deployed stage, revision, and manifest before changing commands. A mismatch fails recovery. Recovery executes the sync implementation from the selected revision, so older revisions retain their original diagnostics and retry behavior.

For a full release, leave **operation** at `release` and leave the manual revision input empty. Automatic releases continue to deploy the checked main SHA.

### Diagnose synchronization failures

The CLI reports a JSON diagnostic with `code`, `operation`, `phase`, `attempt`, `retryCount`, `status`, and numeric `discordCode`. Network failures have no HTTP status. Body decoding errors and request deadlines have distinct codes. Provider response text, request objects, and credentials are omitted.

For a revision containing the current sync implementation, transient network failures and HTTP 500, 502, 503, and 504 responses retry up to four reconciliation attempts within 30 seconds. Individual requests have a four-second deadline. Each retry checks release health and reads current commands before another overwrite. A lost PUT response therefore does not cause another write when the manifest already matches. A stale release or readback disagreement fails immediately. HTTP 400, 401, and 403 responses fail immediately; correct the payload or application access before retrying. Rate limits honor Discord's `retry_after` within the same retry budget.

Use `sync:discord` with `--preflight` and the usual stage, endpoint, and revision arguments for an authenticated read of the application's commands. Preflight does not require the new revision to be deployed and never registers commands. Full releases run it before deployment.

Discord uses raw REST API requests for global command synchronization. Install the application in guilds with command permissions, and configure the interactions URL. Guild IDs come from signed interactions. There is no guild enrollment, guild allowlist, DM command mode, or Discord prefix bot.

## Authorize and repair Twitch

Export the public endpoint and revision arguments as described above. Then run:

```bash
bun --env-file=.env.staging run ops setup --stage staging --endpoint "$ARC_BOT_URL"
bun --env-file=.env.staging run ops status --stage staging --endpoint "$ARC_BOT_URL"
bun --env-file=.env.staging run ops status --stage staging --endpoint "$ARC_BOT_URL" --discord --revision "$ARC_BUILD_REVISION"
```

The operator scripts send the secret bearer credential to `/ops/setup` or `/ops/status`. Keep setup output private because authorization links contain one-time OAuth state. Setup resolves logins to IDs and returns links for the sender's `user:read:chat`, `user:write:chat`, and `user:bot` grants and each broadcaster's `channel:bot` grant. When sender and broadcaster are the same personal account, the authorization requests their combined scopes.

Open each returned link as its intended identity. The redirect validates identity, application, scopes, stage/configuration, expiry, and one-time state. Repeat setup after completing grants. Repetition preserves confirmed current subscriptions and repairs unknown or revoked subscriptions. A signed challenge records pending state; a current enabled observation establishes readiness. Personal mode sends only in the sender's own channel. Dedicated bot mode sends to configured channels and authorized public memberships in local, staging, or production deployments.

The account discards onboarding user access/refresh tokens without revoking the grant. It mints app tokens with client credentials and maintains their startup/hourly validation. Grant survival after onboarding-token expiry remains NOT VERIFIED against live Twitch. Broadcaster authorization loss removes that channel. A fresh owner enrollment can restore it. Shared sender authorization loss requires the operator to renew sender grants. Operator setup reconciles configured and public memberships together while preserving removal vetoes. The account alarm drives credential maintenance and ongoing per-channel subscription recovery.

The optional `--discord` status check reads global command drift using the same exact revision fence. It does not register commands. Use `sync:discord` to repair drift.

## Enroll a public Twitch channel

Public enrollment requires a dedicated bot sender and a working HTTPS EventSub callback. Use `ARC_ENVIRONMENT=bot` with `TWITCH_SENDER_KIND=bot` on `local-*` or `staging`, or the existing production profile on `prod`. Prepare the sender through operator setup first. Personal and synthetic environments reject public enrollment. Each dedicated bot profile still requires a nonempty configured channel set and its own application credentials.

Open `https://YOUR_DEPLOYED_ORIGIN/oauth/twitch/enroll` in a browser, then authorize as the broadcaster whose channel you want to install. This requests only `channel:bot`. The existing `/oauth/twitch/callback` accepts the result. Public enrollment cannot replace the sender or change its sender grants. It discards the onboarding user tokens after validating the application, expiry, broadcaster identity, login, and scopes.

Use the same browser to open `/oauth/twitch/enroll/status`. The response describes only that browser's installation:

- `{"kind":"pending"}` means browser authorization is outstanding.
- `{"kind":"recovering","login":"your_login"}` means the channel remains installed while automatic subscription recovery runs.
- `{"kind":"attention-required","login":"your_login","reason":"sender-authorization-required"}` means authorization or setup must be restored before recovery can finish. Other reasons are `broadcaster-authorization-required`, `ingress-required`, and `setup-required`. The owner can still use **Leave channel**.
- `{"kind":"left","login":"your_login"}` confirms removal for this browser capability until its original expiry.
- `{"kind":"ready","login":"your_login"}` requires the broadcaster and sender grants plus an enabled subscription with a confirmed ID.
- `{"kind":"failed","reason":"authorization-required"}` requires a fresh enrollment. If sender authorization was revoked, the operator must renew the sender first.
- Other failed reasons are `denied`, `expired`, `authorization-failed`, `capacity`, `repair-required`, and `unavailable`.

The browser receives a fresh Secure, HttpOnly, SameSite=Lax `__Host-arctools-enrollment` cookie on each begin. Its maximum lifetime is one day. Each member retains one current browser session. Begin replaces that browser's previous intent. Keep the browser cookie and authorization redirect private. Never copy either into query parameters or evidence. Error responses omit OAuth state, authorization codes, and tokens. Enrollment responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

Authorization intents expire after ten minutes, with at most eight outstanding intents across the environment. Anonymous requests can occupy those slots until expiry. A browser can replace only its own previous intent. No public rate limiter is installed. The public callback permits 16 seconds. Its exchange claim has a 14-second total deadline measured inside the storage transaction, covering three provider requests capped at four seconds each plus storage margin. Operator OAuth retains its 12-second timeout. Channel admission happens atomically when authorization completes. The total channel limit is 32, and an existing member can reauthorize at that limit. OAuth acceptance durably records membership, the broadcaster grant, and an alarm before returning. Repair runs without status polling, shares operator setup's lease, and replaces unknown remote subscription receipts rather than adopting them. A verification challenge alone never establishes readiness.

Use **Leave channel** on `/connect` to remove your Twitch installation, including while status is `recovering`. The browser sends an empty same-origin `POST /oauth/twitch/enroll/leave` with its HttpOnly cookie. The server derives the channel from the session digest. Missing or foreign Origin returns 403, a nonempty body returns 400, another method returns 405, and an expired or replaced capability returns 401. Keep the cookie after success. A retry after a lost response returns the same `left` result until the capability's original expiry. Reinstalling replaces that authority.

Leave, exact `authorization_revoked`, and exact `user_removed` remove channel membership and the `channel:bot` grant. They preserve shared sender scopes, credentials, and unrelated channels. A configured channel also leaves. Setup alone cannot recreate it. A fresh owner OAuth request begun after removal can reinstall it. Old OAuth completions, subscription receipts, notifications, and command work cannot attach to the new installation.

Bans and timeouts retain authorization and membership. Chat subscription loss, webhook delivery failures, and removed EventSub versions stop command admission and trigger automatic recovery. Retries continue after roughly one minute, five minutes, then every fifteen minutes, with up to ten percent jitter. Provider throttle deadlines remain lower bounds across reconstruction. A generic 403 retains grants. Moderator status is recommended but optional. Recovery adds no scopes or unban listener, and it never queues commands for later delivery. New commands resume only after exact owned subscription proof is enabled.

The account retains exact-ID remote deletion obligations until Twitch acknowledges deletion. An owned orphan sweep handles uncertain create results. Revocation tombstones last at least 630001 milliseconds, covering message age and timestamp skew. Minimal channel-ID removal records prevent configuration from restoring removed membership. Browser replay records retain their original absolute expiry. Older keyed installations receive stable installation IDs during migration without adopting unknown remote subscriptions.

If recovery remains unavailable, inspect private operator status and callback reachability. The installed-channel limit remains 32. Setup returns 409 with `channel-capacity-exceeded` when the resolved configuration and public membership exceed that limit. A configuration revision invalidates grants and pending intents while retaining public memberships, so renew sender authorization and enroll affected broadcasters again.

Discord guild and Twitch channel command records expire ten minutes after their original command deadline. Tenant alarms reclaim these records without further traffic, including after a Discord uninstall or Twitch revocation. Once no records remain, `deleteAll()` clears the tenant database. This bot has no Discord Gateway connection; Discord’s `APPLICATION_DEAUTHORIZED` webhook identifies a user rather than a guild, so it cannot identify a guild tenant for immediate deletion. Previously dormant tenant objects with no alarm require a separate sweep or a new request before this expiry policy can run.

The deterministic account and raw HTTP journeys are in `packages/twitch/test/enrollment.test.ts`, `packages/twitch/test/lifecycle.test.ts`, and `tests/website/enrollment.test.ts`. They use the real storage adapter with controlled provider responses. They do not establish live Twitch authorization, onboarding-token-expiry survival, remote alarms, or deployed callback reachability. No live enrollment verification or deployment is recorded by this implementation.

## Verify and clean a local infrastructure run

Run the canonical tenant suite without cloud credentials:

```bash
bun --no-env-file run test:cloud
```

The legacy command runs foundation, cache, account, native alarms, both signed protocols, and all ten commands through Alchemy `dev: true` and real local workerd. Use `bun --no-env-file run scripts/cloud-test.ts foundation`, `cache`, or `account` to run a smaller stack. No tests provision Cloudflare resources or use the cloud state backend. [Local infrastructure testing](verification/local-infrastructure.md) describes isolation and proof boundaries.

Each run owns `.cloud-tests/<stage>/.alchemy/`. The runner strips cloud and application credentials, supplies synthetic identities, and uses a fresh working directory without dotenv files. Test teardown checks absent stage state and output. The runner verifies recorded listeners have stopped before removing local runtime files. JSON evidence stays in `.cloud-tests/<stage>/`.

Retry local cleanup with the exact printed stage:

```bash
bun --no-env-file run test:cloud:cleanup test-tenant-WORKTREE-RUN
```

Cleanup requires the matching `run.json` marked `dev: true`. It rejects old cloud journals. Stop any surviving process from that run before cleanup. CI runs this suite for all PRs, including forks, without test account secrets.

## Recover a resident synthetic PR preview

CI no longer creates resident synthetic PR previews. Explicit `preview:deploy --pr <number>` remains a cloud operation for an authorized operator. Its seven Workers use the existing tenant test composition. No real Twitch or Discord application is registered or authorized. The marked PR comment records the URL, checked merge SHA, PR head SHA, and stage. Fixture data belongs to that PR and may survive pushes and reopening.

Each preview first deploys to obtain the actual output URL, then redeploys with that exact `ARC_BOT_URL`. Publication requires health at the checked revision. This path does not assume that a blank origin works at runtime. Fork PRs run the same local integration checks.

Closing a same-repository PR requests cleanup independently of CI through `pull_request_target: closed`. This trigger supports conflicted PRs. Cleanup checks out trusted `main` code and never checks out the PR head or merge revision. Fork PRs skip the cleanup job. Cleanup reads the current PR state, derives the same stage without old artifacts, and verifies zero Workers, zero namespaces, and absent stage state and output. It keeps the shared state backend. Deploy and cleanup share a repository and PR lock. A queued deploy that observes closure performs cleanup instead. A changed head or merge revision stops URL publication.

After the implementation reaches `main`, retry failed close cleanup through **Remove synthetic preview**, supplying the closed PR number. For local recovery, check out the reviewed implementation. Inject the test account/token and a GitHub token privately. Set `GITHUB_REPOSITORY=PlagueFPS/arc-tools`, then run:

```bash
bun --no-env-file run preview:cleanup --pr 10
```

Replace `10` with the closed PR number. The command accepts PR identity only, requires the PR to be closed, and regenerates `.cloud-tests/<stage>/run.json` before cloud mutations. It does not accept arbitrary `prod`, `staging`, or `local-*` targets. It needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `GITHUB_TOKEN` in the process environment. The workflow supplies test credentials from `CLOUDFLARE_TEST_ACCOUNT_ID` and `CLOUDFLARE_TEST_API_TOKEN`. Use a GitHub token that can read PRs and update their comments.

During initial rollout, `main` may lack the target workflow, so closing a PR may start no cleanup run. If a run starts but `main` lacks `scripts/preview.ts`, cleanup fails with an explicit message that no cleanup occurred. Run the command above from the reviewed implementation, or land the implementation and dispatch cleanup. A deleted PR branch is not needed. Do not execute downloaded recovery artifacts.

Failed jobs retain `run.json`, resource evidence when available, and `preview-result.json`. Use `preview:cleanup --pr <number>` for cloud preview recovery with the same test account and profile. `test:cloud:cleanup` accepts local integration journals only. A failed first deployment may have no output or resource journal; strict cleanup scans the seven exact stage worker names as a fallback. There is no periodic orphan collector. Retain failed workflow artifacts and explicitly retry cleanup.

## Understand launch bounds

A Tenant retains at most 64 work records, allows eight active computations, and caps encoded state at 120 KiB with an 8 KiB reservation per outstanding result. These limits interact; 64 large records need not fit. Replay records remain until ten minutes after their original deadline. Capacity pressure rejects new admission instead of evicting live replay protection. Terminal-only tenants have no maintenance alarm.

The account retains at most 64 send attempts until ten minutes after their deadlines. Multipart results consume an attempt per part, up to eight parts. The shared send policy allows at most 20 reservations in 30 seconds and one per channel per second; the ledger bound can reject earlier. Ambiguous sends stop remaining parts and are not replayed under a new identity. These are quiet-launch capacity limits, not a throughput promise.

Metadata is fresh for 24 hours and validated fallback lasts at most seven days after its last success. Event schedules expire at 60 seconds without stale fallback. Failed refreshes retain a bounded cooldown. No cache warmer or cache alarm runs.

[Current verification evidence](verification/README.md) separates controlled-provider results from live-provider authorization, Discord client privacy and timing, onboarding-token-expiry survival, CI/release configuration, and launch cost. Measure subscribed chat ingress, object requests, external-I/O duration, writes, and credential alarms before making a cost claim.
