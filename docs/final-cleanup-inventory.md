# Final migration cleanup handoff

This read-only inventory was prepared against the accepted root before Unit 3 integration. It is a Unit 5 assignment aid, not authorization to bypass ingress acceptance. The source investigation is `cloudflare-final-cleanup-inventory-r1`. Recheck consumers after the accepted ingress candidate is integrated.

## Delete together

- Remove `apps/discord-bot` and `apps/twitch-bot` as complete workspaces, including their process entrypoints, tests of removed adapters, Discord prefix and DM handling, Twitch database services, Drizzle configuration and app-local migration scripts.
- Remove root `dev:twitch` and `dev:discord` references to those applications.
- Remove the exported singleton `CommandRuntime`, its implementation, and `CommandLayer`. The inventory found only the two legacy apps importing the singleton, and only that runtime using the layer. Preserve `executeCommand`, the registry, and domain behavior tests.
- Regenerate manifests and the lockfile after removing the apps' direct Discord.js, Twurple, Drizzle, libSQL, dotenv, and obsolete platform declarations. Do not edit transitive lock entries by name.
- Remove current operator instructions and application configuration for `DISCORD_CLIENT_ID`, `TWITCH_INITIAL_ACCESS_TOKEN`, `TWITCH_INITIAL_REFRESH_TOKEN`, `TWITCH_BOT_USER_ID`, `TURSO_CONNECTION_URL`, and `TURSO_AUTH_TOKEN`. Do not migrate those values to the replacement runtime. Reassess the obsolete Turso-name scrub in the cloud runner.

## Preserve active consumers

Keep `packages/commands`, `packages/arc-data`, `packages/utils`, and `packages/testing`. Command tests retain all ten outputs, normalization/search fallback, queen alias, event boundaries, and the two-hour upcoming window. Remove only tests confined to the deleted adapters. Direct Vitest tooling has already been removed; optional peer metadata does not establish an installed test runner.

Keep root platform and SQL dependencies required by the pinned Alchemy tooling unless an actual consumer check proves otherwise. The inventory identifies root `@effect/platform-bun`, `@effect/platform-node`, and the SQL adapter overrides as foundation/deployment requirements. Alchemy itself depends on libSQL and its provider graph can retain Turso packages. Removing application database use does not require deleting the infrastructure tool's transitive graph.

## Final integration checks

One integrator owns root manifests, lockfile, stack composition, current README and operator instructions. Preserve `dev`, `deploy`, `ops setup/status`, `sync:discord`, revision/manifest release fencing, environment isolation, and all accepted cloud regression cases. Recheck the accepted Unit 3 runtime, its native cache/account/tenant bindings, test-only provider composition, complete resource tracking, cleanup, and valid signing fixtures. Give the final health response an accurate application status rather than the provisional `foundation` label, updating its consumers together.

Historical verification records remain historical. Add a current index and final integration evidence rather than rewriting past failed runs or old test counts. Existing account owner documents can say unaccepted at their recorded revision while the root review records subsequent acceptance.

Run final build, typecheck, lint, default tests, actual real-cloud ingress/cache/account suite with teardown, and local Worker development flow. Report live authorization, grants after onboarding-token expiry, Discord privacy/registration, observed provider timing, CI configuration, and launch cost separately. This inventory established none of those live gates.
