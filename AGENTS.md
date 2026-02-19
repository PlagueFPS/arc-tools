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

## Tooling

| Tool | Purpose |
|------|---------|
| **Bun** | Package manager, runtime |
| **Turborepo** | Task orchestration, caching |
| **TypeScript** | Type checking, compilation |
| **Biome** | Linting, formatting |
