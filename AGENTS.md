# Project Structure

Arc-Tools is a Turborepo monorepo containing two deployable bots (Twitch and Discord) and a web app that share commands and utilities.

## Project Structure

```
arc-tools/
├── apps/                    # Deployable applications
│   ├── twitch-bot/          # @arctools/twitch-bot
│   ├── discord-bot/         # @arctools/discord-bot
│   └── web/                 # @arctools/web — TanStack Start web app
├── packages/                # Shared internal packages
│   ├── typescript-config/   # @arctools/typescript-config — shared TS config
│   ├── arc-data/            # @arctools/arc-data — Arc Raiders API client & schemas
│   ├── commands/            # @arctools/commands — shared command definitions & registry
│   └── utils/               # @arctools/utils — shared utilities
├── package.json             # Root workspace config
├── turbo.json               # Turborepo task config
├── biome.json               # Linter & formatter config
└── bun.lock                 # Lockfile
```

## Package Namespace

All packages use the `@arctools/` namespace. Internal packages are referenced with `workspace:*` in dependencies.

## Dependency Graph

- **apps** depend on: `@arctools/commands`, `@arctools/utils`
- **commands** depends on: `@arctools/arc-data`, `@arctools/utils`
- **arc-data** depends on: `@arctools/utils`
- All packages extend **typescript-config** for TS settings

## Tooling

| Tool | Purpose |
|------|---------|
| **Bun** | Package manager, runtime |
| **Turborepo** | Task orchestration, caching |
| **TypeScript** | Type checking, compilation |
| **Biome** | Linting, formatting |

## Root Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Build all packages and apps |
| `bun run dev` | Run all dev scripts (watch mode) in parallel |
| `bun run check-types` | Type-check all packages |
| `bun run format-and-lint` | Lint and format with Biome |
| `bun run format-and-lint:fix` | Apply Biome fixes |
| `bun run lint` | Alias for format-and-lint via Turborepo |

## App-Specific Scripts

Each app (`twitch-bot`, `discord-bot`) has:

- `build` — compile TypeScript to `dist/`
- `dev` — `tsc --watch`
- `check-types` — `tsc --noEmit`

## Deployment

Apps are deployed separately. Each app builds its own `dist/` output; shared packages are built first and bundled into each app.

## Key Files

- **tsconfig.json** — Each package extends `@arctools/typescript-config/base.json`
- **biome.json** — Root config; excludes `dist/` and `.turbo/`
- **turbo.json** — Defines `build`, `dev`, `check-types`, and root Biome tasks

## Dynamic Twitch Channel Join

When a user clicks "Add to Twitch" in the web app and completes OAuth, the bot dynamically joins their channel without restart.

| Variable | App | Description |
|----------|-----|-------------|
| `BOT_JOIN_PORT` | twitch-bot | Port for the join API (default: 3847). The API runs only when `BOT_JOIN_SECRET` is set. |
| `BOT_JOIN_SECRET` | twitch-bot | Shared secret for `X-Bot-Join-Secret` header. Required to enable the join API. |
| `BOT_JOIN_API_URL` | web | URL of the bot's join API (e.g. `http://localhost:3847`). Required for callback to trigger join. |
| `APP_URL` | web | Base URL for OAuth redirect (e.g. `http://localhost:3000`). Default: `http://localhost:3000`. |
