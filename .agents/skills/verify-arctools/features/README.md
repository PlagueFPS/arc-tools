# ARCToolsBot verification map

Read the matching recipe before driving the bot. These files describe the maintained verification contract, not a claim that every path has passed.

## Baseline preconditions

Launch a unique local stage with the skill's helper and require Doctor to pass. This baseline has public fixture credentials, empty Durable Object storage, no grants, and no registered Discord application. Only the Discord access recipe is usable immediately. Other journeys must report their missing preconditions as failures to run.

The canonical `bun run test:cloud` supplies controlled Metaforge and Twitch providers, synthetic authorization, real Workers, and SQLite storage. Its full suite arranges the preconditions for both command protocols. Keep its exact stage and recovery journal. Live client journeys require separate nonproduction portal applications and explicit working credentials as described in `docs/operator-guide.md`.

## Driving conventions

Use the real `/interactions/discord` and `/webhooks/twitch` routes with signed bytes. Use the operator CLI for setup and registration. Test controls arrange external-provider data or inspect results. They do not replace ingress or operator actions. The cloud suite runs as a whole because its journeys share setup and ordered state.

## Proof and skip reporting

Record the feature ID, entry point, revision, action, result, and exit status. Capture side effects and negative controls. A passed local protocol check does not prove live Discord visibility or Twitch delivery. Record each unrun entry point and its missing prerequisite. Retain artifacts after cleanup.

## Features

- [Discord access](discord-access.md): signature acceptance, PING, and private rejection of DM commands. This is the generated skill's executable local proof.
- [Item and ARC lookup](item-lookup.md): buy, loot, craft, find, sell, recycle, and recycleto through both platforms.
- [Event lookup](events.md): event, upcoming, and active through both platforms.
- [Twitch authorization and repair](twitch-setup.md): operator setup, OAuth grants, subscription readiness, and status.
- [Discord registration](discord-registration.md): revision-fenced command synchronization and drift status.
