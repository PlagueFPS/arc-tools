# Discord command registration

An operator publishes all ten guild slash commands and checks the remote manifest for drift at an exact build revision.

## Sub-features

- `sync` overwrites and reads back the global manifest when drift exists.
- `fence` rejects a mismatched stage, revision, unready worker, or manifest hash.
- `preflight` checks authenticated application access without a Worker health requirement or registration.
- `recovery` repairs an exact deployed revision through Release with `operation=sync`, under the application lock and without deployment.
- `drift` checks remote definitions without registering commands.
- `client` exposes commands in an installed guild after Discord propagation.

## How to get to it (user POV)

For a configured local environment, run `bun run sync:discord:local` or the combined `bun run setup:local`. Run `bun run status:local` for drift status. Explicit staging and production operations use `sync:discord` and `ops status --discord` as documented in the operator guide.

## Driving it with operator CLI and Discord

Preconditions: a separate nonproduction Discord application, its public key and private bot token, a matching ready worker revision and stage, configured interactions endpoint, and installation in a test guild. The local access baseline uses fixture identities and cannot register real commands.

- **Synchronize.** With `.env.local` configured and `bun run dev:local` running, execute `bun run sync:discord:local`. Capture redacted output and exit status. Require readiness waiting, complete manifest comparison, and read-back agreement.
- **Check drift.** Run `bun run status:local`. Require no Discord command drift for that exact revision. Repeat synchronization and verify the already-matching state remains correct.
- **Client.** Open an installed test guild and verify all ten commands are offered. Execute `/sell` with `item` set to `sensors` and capture its public response. Use another guild member to observe visibility.
- **Controlled registration.** Run `bun --no-env-file test packages/discord/test scripts/preview-workflows.test.ts`. Require CLI preflight, sanitized diagnostics, bounded retries, read-before-repeat after uncertain overwrites, stale revision rejection, and workflow recovery guards to pass. These fixtures make no live Discord calls.
- **Recovery.** In a configured nonproduction stage, dispatch Release with `operation=sync`, the application ID, and the exact deployed SHA. Require deployment to be skipped and command synchronization to pass. Confirm `/health` still reports that SHA. Production recovery requires dispatch from main and a revision in main history.

## Gotchas

- The local fixture baseline's `/health` success does not provide a real application token or installation.
- Global command propagation is asynchronous. Read-back agreement alone does not prove client availability.
- Registration mutates the selected application's global commands. Serialize operations for that application and use its nonproduction credentials.
- `.env.local` wins over stale exported values for local shortcuts. Restart the configured app after changing the file.
- Do not test revision rejection by modifying a shared production worker or command manifest.
