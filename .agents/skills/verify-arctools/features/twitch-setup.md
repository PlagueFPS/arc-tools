# Twitch authorization and repair

An operator authorizes the sender and broadcaster, repairs EventSub subscriptions, and checks account readiness.

## Sub-features

- `setup` resolves configured identities and returns grant links.
- `oauth` accepts each grant once for its intended identity and scopes.
- `repair` preserves enabled subscriptions and repairs revoked or unknown subscriptions.
- `status` reports account and channel readiness.

## How to get to it (user POV)

Use `bun run setup:local` and `bun run status:local` for a configured personal development environment. For an explicit environment, use the `ops setup` and `ops status` commands in `docs/operator-guide.md`. Open the returned authorization links as the intended identity.

## Driving it with operator CLI and chat clients

Preconditions: a protected `.env.local`, a separate personal Twitch application, an HTTPS tunnel, the correct portal OAuth redirect, and private operator/provider credentials. Follow the operator guide to prepare them. The fixture-only local baseline cannot authorize Twitch.

- **Setup.** With the configured environment running under `bun run dev:local`, run `bun run setup:local`. Keep output private. Open each returned grant link, approve as the requested identity, then repeat setup if requested.
- **Status.** Run `bun run status:local`. Require the intended sender and own channel to be ready with a currently enabled subscription. Capture a redacted status record.
- **Delivery.** Send `!sell sensors` in that channel. Capture the command and exactly one threaded bot reply.
- **Repair.** In the isolated nonproduction application, repeat setup and compare the enabled subscription identity before and after. Exercise revocation repair only when that scenario is authorized, then require restored readiness and a successful command.
- **Controlled integration.** `bun run test:cloud` covers synthetic setup, grant callbacks, subscription observation, revocation, and dispatch. Retain its journal and successful cleanup result separately from live evidence.

## Gotchas

- `setup:local` synchronizes Discord first. Missing Discord configuration blocks this entry point even if Twitch is configured.
- A placeholder HTTPS origin cannot receive real OAuth redirects or EventSub delivery.
- Grant links contain one-time OAuth state. Do not include them, bearer credentials, or tokens in proof artifacts.
- `/health` readiness does not prove authorization. Confirm subscriptions with status and actual delivery.
- Grant survival after onboarding-token expiry requires a separate live observation. Synthetic grants do not prove it.
