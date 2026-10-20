---
name: verify-arctools
description: Verify ARCToolsBot's Twitch chat and Discord slash-command HTTP paths, local workerd startup, operator setup, and registration. Use after bot behavior changes to capture observable proof and identify live-provider gaps.
---

# Verify ARCToolsBot

Read [the feature map](features/README.md) and choose the affected journeys. The primary user interfaces are Twitch chat and Discord guild slash commands. Operator CLIs configure those interfaces. There is no web UI.

## Launch

Run from the repository root with Bun 1.4.3:

```bash
bun install --frozen-lockfile
bun run build
export VERIFY_STAGE="local-verify-$(date -u +%Y%m%d%H%M%S)-$$"
printf '%s\n' "$VERIFY_STAGE"
.agents/skills/verify-arctools/scripts/local.sh launch "$VERIFY_STAGE"
```

Keep this terminal session and its exact stage. In another terminal, set `VERIFY_STAGE` to that printed value. Evidence is `.cloud-tests/verify-arctools/$VERIFY_STAGE/` relative to this checkout.

The helper runs the documented Alchemy development command with an explicit `local-*` stage, the current Git revision, and public fixture credentials. It passes `/dev/null` as the CLI environment file and overrides application configuration with fixture values. The personal sender and its sole channel are `local_probe`. The public origin is `https://local-verify.example`. No tunnel, provider grants, or command registration exists in this baseline. No migration or seed is needed for Discord PING and unsupported-context rejection. Durable Objects start empty.

Wait for `[Bot] Started` and the actual HTTP address in `launch.log`, then run Doctor. The default address is `http://localhost:1337`. If Alchemy selects another port, export `ARC_VERIFY_URL` with that exact local HTTP origin in the driving and cleanup terminal. Do not assume the first free port belongs to this run.

The stack uses `Cloudflare.state()`. The selected Alchemy profile must be authenticated even for local development's control-store bookkeeping. The default is `default`; set `ALCHEMY_PROFILE` to an existing profile when necessary. Local workerd does not deploy a cloud bot, but startup and cleanup can contact Cloudflare's state service. This is not an offline or dry-run command.

Isolation uses a unique stage and its stage-specific emulator storage. Alchemy may share local runtime services and choose another port. Never reuse another run's stage or drive a user's existing instance. Serialize local verification if ownership or port selection is unclear. Do not run setup against these fixture identities.

## Doctor

```bash
.agents/skills/verify-arctools/scripts/local.sh doctor "$VERIFY_STAGE"
```

This read-only check requires this stage's launch record and a matching endpoint. It reads `/health` and compares HTTP 200, `status: ready`, exact stage, Git revision, and the locally computed command manifest hash. It saves `doctor.json`. Run it first when requests look wrong. Health proves build identity, not Twitch authorization or Discord command propagation.

## Drive

```bash
.agents/skills/verify-arctools/scripts/local.sh drive "$VERIFY_STAGE"
```

This proves [Discord access](features/discord-access.md) through the real workerd listener. It signs raw request bytes with the existing public Ed25519 fixture, sends a PING, rejects an invalid signature, then sends a DM-context `/sell sensors` interaction. The DM request must receive the exact private installed-server error with `flags: 64` and suppressed mentions. The helper saves requests and responses before assertions and exits nonzero on a mismatch.

The other mapped journeys need additional preconditions. Use the existing canonical `bun run test:cloud` for real Workers, SQLite Durable Objects, controlled provider calls, and all ten commands on both signed protocols. That suite creates billable disposable cloud resources and always attempts destruction. Follow [the operator guide](../../../docs/operator-guide.md) for its credentials and recovery. Do not substitute test-only state setters for a user action. Fixture controls may arrange isolated external-provider conditions and inspect side effects.

For live client journeys, use separately configured nonproduction applications and the operator guide. Keep authentication entry and OAuth grants private. Record missing grants, seed data, or portal configuration as an unmet precondition. Never treat a different entry point's success as proof of the blocked journey.

## Evidence

Keep `launch.log`, `doctor.json`, `discord-access.json`, `drive-result.json`, and `cleanup.json` in `.cloud-tests/verify-arctools/$VERIFY_STAGE/`. The directory is ignored by Git and survives cleanup. Record the checkout revision, feature ID, entry point, command exit status, and any unmet preconditions with the proof. `discord-access.json` captures actions and resulting HTTP status, headers, and bodies. Its signing material is public fixture data.

Prove the real user path and its resulting state. For mutations, inspect resulting files, persisted records, or observed provider messages alongside visible replies. Mock only existing external boundaries. The local access journey is rejected before command execution and sends no chat reply. It does not establish command data fetching, durable command state, real grants, or client privacy. Local workerd stands in for a deployed worker. It supplies fixture configuration and keys, a placeholder HTTPS origin, a local listener, and empty emulator storage. Real portals, reachable callbacks, OAuth authorization, Discord registration, production data, and remote Durable Objects remain unverified by this path.

The cloud suite retains `.cloud-tests/<stage>/run.json`, `resources.json`, `result.json`, and timing observations. Capture its terminal transcript too. Require both test and cleanup success. A timing file alone proves neither behavior nor cleanup. Live Discord privacy requires observing the response as another guild member. Live Twitch proof requires observing exactly one threaded message for the original command and no extra delivery after replay.

## Cleanup

Stop the launch terminal with Ctrl+C. Then use the same stage, profile, and endpoint:

```bash
.agents/skills/verify-arctools/scripts/local.sh cleanup "$VERIFY_STAGE"
test -s ".cloud-tests/verify-arctools/$VERIFY_STAGE/discord-access.json"
test -s ".cloud-tests/verify-arctools/$VERIFY_STAGE/cleanup.json"
```

Cleanup uses Alchemy `Core.destroy` with `dev: true` for this exact local stage, checks absent control-store entries and output, and requires the listener to be stopped. It removes only the stage's bundle and three emulator data directories. It retains logs, proof, and shared Alchemy runtime caches. Never kill by process name or delete shared `.alchemy` state. Run cleanup after failed launch or drive attempts too. A failed cleanup is a failure to report and repair, not a passed proof.

Cloud cleanup uses `bun run test:cloud:cleanup` with the exact stage printed by the runner and its retained `run.json`. Never pass a local stage to that cloud recovery command.

## Helpers

Both files are executable. Invoke `scripts/local.sh` from the repository root as shown above. It supplies isolated configuration and calls `scripts/probe.ts` for `doctor`, `drive`, and `cleanup`; do not invoke the probe without that configuration. `ARC_VERIFY_URL` selects the observed local address. `ALCHEMY_PROFILE` selects the same profile for launch and cleanup.

Keep this map current with `/maintain-verification-skill` when commands or entry points change.

## Verified run

On 2026-10-20, stage `local-verify-proof-20261020` passed launch, Doctor, signed PING, invalid-signature rejection, and private DM rejection. Cleanup confirmed absent stage state/output and a stopped listener. All five proof files listed above survived cleanup under `.cloud-tests/verify-arctools/local-verify-proof-20261020/`. This was a local workerd proof with public fixture identities. Cloud integration and live-provider journeys were not run for this skill's creation.
