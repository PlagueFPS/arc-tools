# Discord access

Discord verifies the interaction endpoint with a signed PING. Commands outside an installed guild receive a private error.

## Sub-features

- `discord-ping` accepts a correctly signed PING and returns `{"type":1}`.
- `discord-signature` rejects a bad signature with HTTP 401 and no body.
- `discord-dm` rejects `/sell sensors` in DM context with the installed-server error and private response flags.

## How to get to it (user POV)

- A Discord application operator configures the interactions endpoint, which Discord validates with PING.
- A user attempts a slash command outside an installed server. The current manifest only advertises guild commands.

## Driving it with signed HTTP

Preconditions: the skill's isolated local stage is running and Doctor passes. The public fixture Ed25519 key must match the helper's configuration.

- **Drive.** Run `.agents/skills/verify-arctools/scripts/local.sh drive "$VERIFY_STAGE"`. It sends all three requests through `/interactions/discord`.
- **Check.** Require exit 0 and `drive-result.json` with `passed: true`. Inspect `discord-access.json` for the PING action and exact response, the invalid signature's 401, and the DM command's type 4 response. Its content is `Use a slash command from an installed server.`, flags are 64, and allowed mentions are empty.
- **Retain.** Stop the owned launch session, run cleanup, and confirm the request/response evidence and cleanup record still exist.

## Gotchas

- A PING alone does not prove command execution.
- The helper's DM payload deliberately lacks guild membership. This exercises the ingress rejection that protects this unsupported context.
- The guild-only manifest may prevent a real Discord client from offering the DM command. Synthetic DM rejection proves server behavior only.
- Flags prove the HTTP privacy instruction. Observe a real guild member's client to prove Discord display behavior.
- The baseline needs no provider grants and does not execute command business logic or send a provider message.
