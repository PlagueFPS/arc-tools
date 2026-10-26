# Local infrastructure testing

`bun --no-env-file run test:cloud` runs all infrastructure integration cases locally. The command and `tests/cloud/` directory retain their historical names. Cloudflare credentials, account limits, and remote control state are no longer prerequisites.

## Runtime and state

`foundation.test.ts` passes `dev: true`, `Cloudflare.providers()`, and `localState()` to both `Test.make` and `makeStack`. Alchemy beta.84's `Test/Core.ts` resolves development mode independently of state. Its `Stack.ts` builds the stack's own state layer, so changing only `Test.make` would still initialize the cloud backend. `makeStack` lets the suite supply local state throughout. The default export retains the existing cloud backend for explicit deployment commands.

The runner assigns a unique worktree/run stage and starts Bun with `.cloud-tests/<stage>/` as its working directory. Alchemy stores file state, bundles, logs, and emulator data inside that run's `.alchemy/`. This also prevents Alchemy's independent dotenv loader from reading the repository's `.env`. Child processes receive synthetic application credentials, a dedicated `local-tests` profile, `CI=true`, and no inherited Cloudflare credentials or Alchemy overrides. Telemetry is disabled. The suite rejects `ALCHEMY_TEST_DEV` overrides because that setting takes precedence over `dev: true`.

Cloudflare's local Worker providers run real workerd and SQLite Durable Objects. Fixture APIs also run in workerd. The fixture HTTP observer registers each actual loopback origin with its role and retains its existing route restrictions. Startup checks local provider state and loopback URLs instead of listing remote namespaces.

Local transport uses HTTP loopback. The synthetic Bot keeps `https://fixture.invalid` as its public callback identity because Twitch requires HTTPS callback URLs. Signed requests still go to the actual workerd URL. Production and staging retain HTTPS origin checks. The operator CLI accepts HTTP loopback only for disposable test stages.

## Cleanup and CI

The test adapter destroys the local stack and checks absent stage state and output. After the test child exits, the runner verifies TCP connection refusal at every recorded Worker origin before deleting that run's `.alchemy/`. Evidence remains beside it. Cleanup errors fail the command. Retry with `bun --no-env-file run test:cloud:cleanup <exact-stage>`. A local `run.json` with `dev: true` is required. Old cloud journals cannot select remote cleanup.

CI runs the tenant suite on all PRs, including forks, without Cloudflare secrets. Automatic resident preview deployment has been removed to avoid provisioning resources during checks. Existing explicit preview commands, close-event preview cleanup, and production release behavior remain available. Cloud preview cleanup still uses the separate cloud helper and credentials.

## Proof boundaries

The suite retains SQLite rollback and reconstruction, native alarm retries and credential recovery, cache expiry and concurrency, account authorization and dispatch, signed ingress, Discord deadlines, and all ten command journeys. These are local runtime integration proofs. They do not establish Cloudflare routing, deployed callback reachability, live Twitch grants, live Discord registration, or cloud namespace counts.

Older files in this directory record historical cloud runs. Their remote-state and credential instructions do not describe the current test runner.

## Verified on 2026-10-26

All four local stack variants passed without cloud credentials. Each reported `testResult: 0` and `cleanupResult: 0`.

| Suite      | Stage                                   | Tests | Assertions |
| ---------- | --------------------------------------- | ----- | ---------- |
| Foundation | `test-foundation-7ebf600c-c5abab16af30` | 3     | 26         |
| Cache      | `test-cache-7ebf600c-4fd6dca203e6`      | 8     | 137        |
| Account    | `test-account-7ebf600c-c7859a840afc`    | 16    | 269        |
| Tenant     | `test-tenant-7ebf600c-74c37af93da3`     | 23    | 646        |

The required root commands passed in order with `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run test`. Repeating local cleanup for the tenant stage succeeded and preserved its successful test result. Recovery identities and HTTP evidence remain under `.cloud-tests/<stage>/`.

An earlier tenant run, `test-tenant-7ebf600c-34649bcd986d`, failed one raw account status request with `ECONNRESET` while the default test command also ran. Its failure result remains retained. Later isolated tenant and account runs passed. The reset's cause is unconfirmed; no request replay or relaxed assertion was added.
