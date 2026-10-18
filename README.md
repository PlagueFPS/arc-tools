# ARCToolsBot

ARC Raiders commands for Twitch chat and Discord guild slash commands. One Alchemy stack runs a Cloudflare Worker with SQLite-backed Tenant, TwitchAccount, and ArcCache Durable Objects. Command execution uses Effect 4 and a shared command registry.

| Command | Twitch usage | Result |
| --- | --- | --- |
| loot | `!loot <arc>` | Items dropped by an ARC. |
| buy | `!buy <item>` | Trader and purchase price. |
| craft | `!craft <item>` | Ingredients and workbench. |
| find | `!find <item>` | Loot areas. |
| sell | `!sell <item>` | Sale value. |
| recycle | `!recycle <item>` | Recycling output. |
| recycleto | `!recycleto <item>` | Items that recycle into the requested item. |
| event | `!event <event or map>` | Matching event information. |
| upcoming | `!upcoming` | Events within the next two hours. |
| active | `!active` | Active events. |

Discord exposes the same ten commands as `/loot`, `/buy`, and the other registry names. Guild slash successes are public. Errors are private initial responses. There is no unconditional deferral or later interaction-token POST.

Use Bun **1.3.5**. Alchemy **2.0.0-beta.83**, Effect **4.0.4**, and the Cloudflare worker types are pinned in the manifests and lockfile.

```bash
bun --version
bun install --frozen-lockfile
bun run build
bun run check-types
bun run lint
bun run test
```

The default tests include the eight strict cloud-helper cases. The separate `bun run test:cloud` suite deploys disposable real Cloudflare resources and verifies teardown. It requires Cloudflare credentials or an authenticated Alchemy profile and never silently skips missing credentials.

For development, deployment, Twitch authorization, health/status, and Discord registration, follow [the operator guide](docs/operator-guide.md). Copy [.env.example](.env.example) for public configuration placeholders and inject secrets privately.

For a new local tunnel session, edit `ARC_PUBLIC_URL` in `.env.local`, run `bun run dev:local` in one terminal, and run `bun run setup:local` in another. Update the portal endpoints manually if the tunnel host changed. Keep setup's OAuth output private.

[Verification records](docs/verification/README.md) distinguish accepted implementation units from unperformed live-provider, privacy, token-expiry, CI, and cost gates. The intended launch is a few quiet channels and guilds. It carries no free-tier cost guarantee.

Data comes from [Metaforge's ARC Raiders API](https://metaforge.app/arc-raiders). Existing command fixture behavior, including event selection boundaries, is preserved.
