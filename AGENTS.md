# Project Structure

Arc-Tools is a Turborepo monorepo containing two deployable bots (Twitch and Discord) that share commands, database access, and utilities.

## Project Structure

```
arc-tools/
├── apps/                    # Deployable applications
│   ├── twitch-bot/          # @arctools/twitch-bot
│   └── discord-bot/         # @arctools/discord-bot
├── packages/                # Shared internal packages
│   ├── typescript-config/   # @arctools/typescript-config — shared TS config
│   ├── commands/            # @arctools/commands — shared command definitions
│   ├── database/             # @arctools/database — shared DB client/schema
│   └── utils/               # @arctools/utils — shared utilities
├── package.json             # Root workspace config
├── turbo.json               # Turborepo task config
├── biome.json               # Linter & formatter config
└── bun.lock                 # Lockfile
```

## Package Namespace

All packages use the `@arctools/` namespace. Internal packages are referenced with `workspace:*` in dependencies.

## Dependency Graph

- **apps** depend on: `@arctools/commands`, `@arctools/database`, `@arctools/utils`
- **commands** and **database** depend on: `@arctools/utils`
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
