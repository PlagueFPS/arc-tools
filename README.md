# ARCToolsBot

ARC Raiders commands for Twitch chat and Discord guild slash commands. One Alchemy stack runs a Cloudflare Worker with SQLite-backed Tenant, TwitchAccount, and ArcCache Durable Objects. Command execution uses Effect 4 and a shared command registry.

| Command   | Twitch usage            | Result                                      |
| --------- | ----------------------- | ------------------------------------------- |
| loot      | `!loot <arc>`           | Items dropped by an ARC.                    |
| buy       | `!buy <item>`           | Trader and purchase price.                  |
| craft     | `!craft <item>`         | Ingredients and workbench.                  |
| find      | `!find <item>`          | Loot areas.                                 |
| sell      | `!sell <item>`          | Sale value.                                 |
| recycle   | `!recycle <item>`       | Recycling output.                           |
| recycleto | `!recycleto <item>`     | Items that recycle into the requested item. |
| event     | `!event <event or map>` | Matching event information.                 |
| upcoming  | `!upcoming`             | Events within the next two hours.           |
| active    | `!active`               | Active events.                              |

Discord exposes the same ten commands as `/loot`, `/buy`, and the other registry names. Guild slash successes are public. Errors are private initial responses. There is no unconditional deferral or later interaction-token POST.

Use Bun **1.4.3**. Alchemy **2.0.0-beta.83**, Effect **4.0.4**, and the Cloudflare worker types are pinned in the manifests and lockfile.

```bash
bun --version
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run fmt
bun run test
```

`bun run lint` checks code with Oxlint and reports warnings without failing on them.
`bun run fmt` checks formatting with Oxfmt. Configure them in `oxlint.config.ts`
and `oxfmt.config.ts`. Run `bun run lint:fix` to apply lint fixes and
`bun run fmt:fix` to sort imports and format files. VS Code and Cursor users can
install the recommended Oxc extension for formatting and lint fixes on save.

The default tests include fixture HTTP, local CLI, preview lifecycle, and workflow guard cases. The separate `bun run test:cloud` suite runs the complete infrastructure integration suite locally through Alchemy `dev: true` and real workerd. The legacy command name does not imply cloud deployment. Tests use local file state and require no Cloudflare credentials or authenticated profile. See [local infrastructure testing](docs/verification/local-infrastructure.md).

Every PR, including forks, runs local infrastructure integration tests without cloud credentials. CI no longer deploys resident PR previews automatically. Explicit `preview:deploy` and `preview:cleanup` commands remain available for authorized cloud operations. A successful `main` push still calls the Release workflow for production. Configure [CI/CD bootstrap](docs/ci-cd-bootstrap.md) and the existing environment applications before activation. Remote CI/CD remains UNVERIFIED until operator setup and real workflow runs succeed. [The CI/CD record](docs/verification/alchemy-cicd.md) lists the local checks and rollout limits.

For development, deployment, Twitch authorization, health/status, and Discord registration, follow [the operator guide](docs/operator-guide.md). Copy [.env.example](.env.example) for public configuration placeholders and inject secrets privately.

The website in `apps/website` uses Foldkit, Tailwind CSS, and foldcn components. Its home and connection pages are prerendered at build time. Run `bun run dev:web` for a standalone visual preview at `http://localhost:3000/`. Website owns OAuth and the browser session and calls Bot through a typed private service binding in the generated Worker. The native Foldkit development host runs in Node without that binding, so complete enrollment requires a binding-capable Worker runtime. See [the website architecture](docs/website-architecture.md).

For public enrollment with a real test Twitch application, select the dedicated `bot` profile in `.env.local` and follow [local tunnel enrollment](docs/operator-guide.md#exercise-public-enrollment-through-a-local-tunnel). Only Bot needs an HTTPS tunnel for webhooks. Register `http://localhost:3000/oauth/twitch/callback` for local OAuth; the browser returns to Website on your computer.

Start a Bot tunnel with `bun run tunnel --url http://localhost:1337` using the Bot port printed by Alchemy. Install `cloudflared` on your PATH first. For a new local tunnel session, set `ARC_BOT_URL` to the Bot tunnel origin in `.env.local`, run `bun run dev:local` in one terminal, and run `bun run setup:local` in another. Update the portal endpoints manually if the tunnel host changed. Keep setup's OAuth output private. Website defaults to `http://localhost:3000` outside production. Production requires `ARC_WEBSITE_URL` matching its HTTPS Worker origin. See [retiring personal-sender setup](docs/operator-guide.md#retire-personal-sender-setup) for obsolete token files and the grants still required by dedicated applications.

[Verification records](docs/verification/README.md) distinguish accepted implementation units from unperformed live-provider, privacy, token-expiry, CI, and cost gates. The intended launch is a few quiet channels and guilds. It carries no free-tier cost guarantee.

Data comes from [Metaforge's ARC Raiders API](https://metaforge.app/arc-raiders). Existing command fixture behavior, including event selection boundaries, is preserved.
