# Operate ARCToolsBot

## Prepare an environment

1. Install Bun 1.3.5 and run `bun install --frozen-lockfile` at the repository root.
2. Create a separate Twitch developer application and Discord application for each independently active environment. Local development and staging each use the personal Twitch account and only its own channel. Production uses a dedicated sender and an explicit channel-login list.
3. Copy `.env.example` to an ignored environment file, such as `.env.local` or `.env.staging`. Replace public placeholders and enter secrets through a private editor or your secret manager. Set file permissions with `chmod 600 .env.local`. Never commit the filled file.
4. Select your Cloudflare account and Alchemy authentication profile. `bunx --no-install alchemy profile list` and `bunx --no-install alchemy profile current` inspect profiles. If needed, use `alchemy profile create` and `alchemy profile edit` through the same `bunx --no-install` prefix.

An Alchemy profile selects provider authentication. A stage selects the application's resources and identities. They are independent. Pass `--profile default` or another existing profile explicitly. The stack requires `ARC_STAGE`, `APPLICATION_STAGE`, and `--stage` to agree. Its supported application stages are `local-<name>`, `staging`, and `prod`; disposable tests select their own unique `test-...` stage. Resident PR previews derive a stable `test-tenant-<8hex>-<12hex>` stage from the repository and PR number. Both test paths use synthetic identities.

Keep the Cloudflare state control backend. It stores deployment state separately from each application's resources. Disposable test cleanup destroys the selected application stage and verifies its absence while retaining that backend.

## Configure bindings

The stack reads these names. The worker captures ordinary configuration and uses `Config.Redacted` for application secrets.

| Public name                      | Value                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARC_STAGE`, `APPLICATION_STAGE` | The same explicit stage.                                                                                                                                                                                                                                                                                                 |
| `ARC_ENVIRONMENT`                | `personal` for local/staging; `production` for prod.                                                                                                                                                                                                                                                                     |
| `ARC_BUILD_REVISION`             | The deployed Git revision. Health and registration compare it exactly. Default is `unreleased` for development.                                                                                                                                                                                                          |
| `ARC_PUBLIC_URL`                 | Required explicit HTTPS tunnel origin for local development. For staging and production, preserve the exact working HTTPS origin from the deployed `Worker.URL`. The release workflow requires it before deployment. A missing value caused the first production runtime failure until it was configured and redeployed. |
| `TWITCH_SENDER_KIND`             | `personal` for local/staging; `bot` for prod.                                                                                                                                                                                                                                                                            |
| `TWITCH_SENDER_LOGIN`            | Lowercase sender login. Setup resolves it to an ID.                                                                                                                                                                                                                                                                      |
| `TWITCH_CHANNEL_LOGINS`          | Comma-separated lowercase manual logins. Local/staging requires exactly the personal sender login. Production supports up to 32 configured channels.                                                                                                                                                                     |
| `TWITCH_CLIENT_ID`               | This environment's Twitch application.                                                                                                                                                                                                                                                                                   |
| `DISCORD_APPLICATION_ID`         | This environment's Discord application.                                                                                                                                                                                                                                                                                  |
| `DISCORD_PUBLIC_KEY`             | That application's 64-hex-character Ed25519 verification key.                                                                                                                                                                                                                                                            |
| `CLOUDFLARE_ACCOUNT_ID`          | Target Cloudflare account.                                                                                                                                                                                                                                                                                               |
| `ALCHEMY_PROFILE`                | Optional authentication-profile selection when no explicit `--profile` is passed.                                                                                                                                                                                                                                        |

Inject `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_BOT_TOKEN`, and `OPERATOR_SECRET` privately. Cloudflare API-token authentication additionally uses `CLOUDFLARE_API_TOKEN`. The Discord bot token remains required for CLI command registration and drift checks even though interaction replies use the incoming HTTP response.

Pinned Alchemy has no application-secret `set` command. Its CLI accepts `--env-file`; this repository uses its default environment/config provider. Without that flag, exported process values override `.env`. An explicit `--env-file` takes precedence over process values for names in that file. Put public configuration in the file and inject secrets through your secret manager's environment wrapper, or use a protected ignored file for both. Do not put secret values in command arguments, shell history, output logs, or chat.

Bun's `--env-file` loads the environment for the operator scripts, which do not accept Alchemy's flag. Exported process values take precedence over Bun's file values. The local shortcuts below explicitly give `.env.local` values precedence, including application secrets. Names absent from the file fall back to the environment, so secret-manager wrappers still work. CLI profile credentials do not supply application secrets. Synthetic provider endpoints and test control routes cannot be selected for personal or production environments.

## Develop with local workerd

Set both stage fields to `local-yourname`, `ARC_ENVIRONMENT=personal`, `TWITCH_SENDER_KIND=personal`, and both login fields to your own login. Use separate local portal applications. Set `ARC_PUBLIC_URL` to a reachable HTTPS tunnel origin without a path, query, fragment, or credentials.

For each new tunnel session, edit `ARC_PUBLIC_URL` in the repository root's protected `.env.local`. Keep the tunnel running separately. In terminal 1, start development:

```bash
bun run dev:local
```

Alchemy prints the actual local HTTP address. Point your HTTPS tunnel at that address. The shortcut prints these public routes for you to paste into the corresponding portal applications:

- Discord interactions endpoint is `https://YOUR_ORIGIN/interactions/discord`.
- Twitch EventSub callback is `https://YOUR_ORIGIN/webhooks/twitch`.
- Twitch OAuth redirect is `https://YOUR_ORIGIN/oauth/twitch/callback`.

If the tunnel host changed, update the Discord interactions endpoint and Twitch OAuth redirect manually. Editing `ARC_PUBLIC_URL` does not change either portal. Setup uses the configured EventSub callback when it repairs subscriptions.

In terminal 2, register Discord commands and run Twitch setup:

```bash
bun run setup:local
```

Setup runs the existing Discord sync with `--wait`, then the existing operator setup command. A failed sync stops setup. Registration checks the exact stage, revision, ready status, and manifest hash before it changes commands. OAuth links print last. Keep setup output private because those links contain one-time OAuth state. Open each link yourself as the intended identity, then repeat `bun run setup:local` after completing grants if setup requests it. The shortcut does not open a browser.

Use `bun run status:local` for Twitch status and Discord drift at the selected revision. Use `bun run sync:discord:local` to repeat only Discord synchronization with readiness waiting.

All four shortcuts read `.env.local` themselves and accept no additional arguments. They require matching `local-*` stage fields and a personal sender in its own single channel. Every child receives the resolved file values, even when stale values remain exported in the shell. `ARC_BUILD_REVISION` defaults to `unreleased` only when absent from both sources. If you set it, use the same nonempty revision for development and setup. Set `ALCHEMY_PROFILE` in the file or environment to select a profile, or omit it to use Alchemy's configured selection. Restart development after changing the file. The generic `dev`, `deploy`, `ops`, and `sync:discord` commands retain their explicit release flags.

Inspect `GET /health` at the local address. It returns `status: "ready"`, the stage, revision, and command manifest hash. This proves application build identity, not provider authorization. Stop development with Ctrl+C. Local workerd is an interactive development check; real Cloudflare tests provide integration acceptance.

A placeholder HTTPS origin can exercise health and signed PING locally without a tunnel or provider calls. It cannot receive live webhooks or OAuth redirects.

## Deploy and register a release

Set both stage fields to `staging`, the personal identity fields, and the staging portal applications. Set `ARC_BUILD_REVISION` to the intended commit. For production, set both stage fields to `prod`, `ARC_ENVIRONMENT=production`, and `TWITCH_SENDER_KIND=bot`; supply the dedicated sender and manual channel logins.

```bash
bun run build
bun run check-types
bun run lint
bun run test
bun run deploy --stage staging --profile default --env-file .env.staging --yes
```

Keep `ARC_PUBLIC_URL` equal to the exact working deployed origin. Do not guess a workers.dev hostname or overwrite the existing production value. Missing `ARC_PUBLIC_URL` caused the first production runtime failure. Setting the exact URL and redeploying repaired it. For a new cloud service, read the actual stack output, configure that exact origin, and redeploy before registration. Inspect `/health` and compare stage, revision, and manifest hash.

The Release workflow accepts only explicit `staging` or `prod` and an application ID. Successful CI on a `main` push calls the same workflow with the exact checked SHA and repository variable `PROD_DISCORD_APPLICATION_ID`. Manual production dispatch must select `main`; staging dispatch uses its existing environment. Both paths serialize by application ID and require the environment's `DISCORD_APPLICATION_ID` to match the input. Automatic releases recheck the current main head after acquiring the lock and immediately before deployment. The workflow checks out the exact revision, deploys it, and registers the global manifest. Registration checks the deployed stage, revision, ready status, and hash before and after operations. It compares all global commands with full localization dictionaries and reads back an overwrite. A partial release leaves the deployment running and reports incomplete registration. Repair through the same Release workflow at the intended branch revision.

Follow [the CI/CD bootstrap guide](ci-cd-bootstrap.md) before enabling automatic releases. Populate the existing bot application variables and secrets privately in `prod` and `staging`. Preserve the current portal callbacks and Twitch grants. Remote CI/CD activation remains UNVERIFIED until bootstrap, environment configuration, and real workflow runs succeed. See [the CI/CD verification record](verification/alchemy-cicd.md) for local evidence and rollout limits.

Keep `TWITCH_CLIENT_SECRET`, `TWITCH_SIGNING_SECRET`, `DISCORD_BOT_TOKEN`, `OPERATOR_SECRET`, and `CLOUDFLARE_API_TOKEN` in their selected GitHub environment. CI forwards these five secret names to Release explicitly. Release declares each name required and rejects empty values before dependency installation or API calls. A missing-value failure reports secret names only. Manual dispatch resolves the same environment secrets directly.

For manual registration or repair, export the actual deployed origin and the exact revision that just deployed. The protected file must agree with them. If you deployed the current checkout:

```bash
export ARC_PUBLIC_URL=https://YOUR_DEPLOYED_ORIGIN
export ARC_BUILD_REVISION="$(git rev-parse HEAD)"
bun --env-file=.env.staging run sync:discord --stage staging --endpoint "$ARC_PUBLIC_URL" --revision "$ARC_BUILD_REVISION" --wait
```

The shell must already export `ARC_PUBLIC_URL` and `ARC_BUILD_REVISION` for those argument expansions. Alternatively replace the two arguments with the actual public origin and exact commit. Bun loads the script's application ID and bot token from the protected file or environment. `--wait` bounds readiness polling to 60 attempts; it does not bypass the revision fence. Serialize manual registration with releases for the same application.

Discord uses raw REST API requests for global command synchronization. Install the application in guilds with command permissions, and configure the interactions URL. Guild IDs come from signed interactions. There is no guild enrollment, guild allowlist, DM command mode, or Discord prefix bot.

## Authorize and repair Twitch

Export the public endpoint and revision arguments as described above. Then run:

```bash
bun --env-file=.env.staging run ops setup --stage staging --endpoint "$ARC_PUBLIC_URL"
bun --env-file=.env.staging run ops status --stage staging --endpoint "$ARC_PUBLIC_URL"
bun --env-file=.env.staging run ops status --stage staging --endpoint "$ARC_PUBLIC_URL" --discord --revision "$ARC_BUILD_REVISION"
```

The operator scripts send the secret bearer credential to `/ops/setup` or `/ops/status`. Keep setup output private because authorization links contain one-time OAuth state. Setup resolves logins to IDs and returns links for the sender's `user:read:chat`, `user:write:chat`, and `user:bot` grants and each broadcaster's `channel:bot` grant. When sender and broadcaster are the same personal account, the authorization requests their combined scopes.

Open each returned link as its intended identity. The redirect validates identity, application, scopes, stage/configuration, expiry, and one-time state. Repeat setup after completing grants. Repetition preserves confirmed current subscriptions and repairs unknown or revoked subscriptions. A signed challenge records pending state; a current enabled observation establishes readiness. Local and staging send through the personal account only in its own channel. Production sends through its dedicated bot to the environment's configured resolved channels.

The account discards onboarding user access/refresh tokens without revoking the grant. It mints app tokens with client credentials and maintains their startup/hourly validation. Grant survival after onboarding-token expiry remains NOT VERIFIED against live Twitch. Revocation stops affected delivery and requires operator attention, renewed grants when requested, and repeated setup. Subscriptions are reconciled by setup, configuration changes, or manual repair; there is no subscription polling loop.

The optional `--discord` status check reads global command drift using the same exact revision fence. It does not register commands. Use `sync:discord` to repair drift.

## Verify and clean a disposable cloud run

Use an authenticated Alchemy profile or inject a test account/token. These tests select synthetic portal credentials and controlled HTTPS providers. They do not mutate real Twitch or Discord applications.

```bash
bun run test:cloud
```

The canonical tenant suite includes foundation, cache, account, native alarms, both signed protocols, and all ten commands. It uses real Cloudflare Workers and SQLite Durable Objects with `Cloudflare.state()`. It rejects local integration mode, retains failures, and retries only the observed pre-execution Cloudflare 404 placeholder. Unknown POST completion and executed business failures are terminal.

The runner prints a unique stage and always attempts destruction. If cleanup fails, use its retained journal:

```bash
bun run test:cloud:cleanup test-tenant-WORKTREE-RUN
```

Replace the example with the exact printed stage. Recovery requires `.cloud-tests/<stage>/run.json` and the same Cloudflare account/profile. Successful cleanup verifies zero matching Workers, zero matching namespaces, and absent stage state/output. CI preserves JSON recovery artifacts even on failure. CI expects `CLOUDFLARE_TEST_ACCOUNT_ID` as a variable and `CLOUDFLARE_TEST_API_TOKEN` as a secret. Remote GitHub settings and execution remain NOT VERIFIED unless separately inspected and run.

## Recover a resident synthetic PR preview

A trusted PR gets a resident synthetic service after all CI checks, including the random disposable cloud suite, pass. Its seven Workers use the existing tenant test composition. No real Twitch or Discord application is registered or authorized. The marked PR comment records the URL, checked merge SHA, PR head SHA, and stage. Fixture data belongs to that PR and may survive pushes and reopening.

Each preview first deploys to obtain the actual output URL, then redeploys with that exact `ARC_PUBLIC_URL`. Publication requires health at the checked revision. This path does not assume that a blank origin works at runtime. Fork PRs run local checks and explicitly skip cloud acceptance and preview deployment.

Closing a same-repository PR requests cleanup independently of CI through `pull_request_target: closed`. This trigger supports conflicted PRs. Cleanup checks out trusted `main` code and never checks out the PR head or merge revision. Fork PRs skip the cleanup job. Cleanup reads the current PR state, derives the same stage without old artifacts, and verifies zero Workers, zero namespaces, and absent stage state and output. It keeps the shared state backend. Deploy and cleanup share a repository and PR lock. A queued deploy that observes closure performs cleanup instead. A changed head or merge revision stops URL publication.

After the implementation reaches `main`, retry failed close cleanup through **Remove synthetic preview**, supplying the closed PR number. For local recovery, check out the reviewed implementation. Inject the test account/token and a GitHub token privately. Set `GITHUB_REPOSITORY=PlagueFPS/arc-tools`, then run:

```bash
bun --no-env-file run preview:cleanup --pr 10
```

Replace `10` with the closed PR number. The command accepts PR identity only, requires the PR to be closed, and regenerates `.cloud-tests/<stage>/run.json` before cloud mutations. It does not accept arbitrary `prod`, `staging`, or `local-*` targets. It needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `GITHUB_TOKEN` in the process environment. The workflow supplies test credentials from `CLOUDFLARE_TEST_ACCOUNT_ID` and `CLOUDFLARE_TEST_API_TOKEN`. Use a GitHub token that can read PRs and update their comments.

During initial rollout, `main` may lack the target workflow, so closing a PR may start no cleanup run. If a run starts but `main` lacks `scripts/preview.ts`, cleanup fails with an explicit message that no cleanup occurred. Run the command above from the reviewed implementation, or land the implementation and dispatch cleanup. A deleted PR branch is not needed. Do not execute downloaded recovery artifacts.

Failed jobs retain `run.json`, resource evidence when available, and `preview-result.json`. Existing `test:cloud:cleanup <exact-stage>` also accepts the regenerated journal when you restore it locally. Use the same test account and profile. That lower-level recovery verifies strict destruction but does not update the PR comment. A failed first deployment may have no output or resource journal; strict cleanup scans the seven exact stage worker names as a fallback. There is no periodic orphan collector. Retain failed workflow artifacts and explicitly retry cleanup.

## Understand launch bounds

A Tenant retains at most 64 work records, allows eight active computations, and caps encoded state at 120 KiB with an 8 KiB reservation per outstanding result. These limits interact; 64 large records need not fit. Replay records remain until ten minutes after their original deadline. Capacity pressure rejects new admission instead of evicting live replay protection. Terminal-only tenants have no maintenance alarm.

The account retains at most 64 send attempts until ten minutes after their deadlines. Multipart results consume an attempt per part, up to eight parts. The shared send policy allows at most 20 reservations in 30 seconds and one per channel per second; the ledger bound can reject earlier. Ambiguous sends stop remaining parts and are not replayed under a new identity. These are quiet-launch capacity limits, not a throughput promise.

Metadata is fresh for 24 hours and validated fallback lasts at most seven days after its last success. Event schedules expire at 60 seconds without stale fallback. Failed refreshes retain a bounded cooldown. No cache warmer or cache alarm runs.

[Current verification evidence](verification/README.md) separates controlled-provider results from live-provider authorization, Discord client privacy and timing, onboarding-token-expiry survival, CI/release configuration, and launch cost. Measure subscribed chat ingress, object requests, external-I/O duration, writes, and credential alarms before making a cost claim.
