#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
action=${1:?Use launch, doctor, drive, or cleanup}
stage=${2:?Supply a unique local-verify- stage}
if [[ ! "$stage" =~ ^local-verify-[a-z0-9-]+$ ]]; then
  echo 'Stage must match local-verify-[a-z0-9-]+' >&2
  exit 1
fi
# Public fixture values intentionally replace any loaded application configuration.
export ARC_STAGE="$stage" APPLICATION_STAGE="$stage"
export ARC_ENVIRONMENT=personal ARC_BUILD_REVISION="$(git rev-parse HEAD)"
export ARC_PUBLIC_URL=https://local-verify.example
export TWITCH_SENDER_KIND=personal TWITCH_SENDER_LOGIN=local_probe TWITCH_CHANNEL_LOGINS=local_probe
export TWITCH_CLIENT_ID=fixture-twitch DISCORD_APPLICATION_ID=fixture-discord
export TWITCH_CLIENT_SECRET=fixture-secret
export TWITCH_SIGNING_SECRET=fixture-signing DISCORD_BOT_TOKEN=fixture-token OPERATOR_SECRET=fixture-operator
export DISCORD_PUBLIC_KEY=d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
unset ALCHEMY_DEV ALCHEMY_TEST_DEV ALCHEMY_STAGE ALCHEMY_TEST_STAGE
case "$action" in
  launch)
    mkdir -p ".cloud-tests/verify-arctools/$stage"
    bun --no-env-file run dev --stage "$stage" --profile "${ALCHEMY_PROFILE:-default}" --env-file /dev/null --no-input 2>&1 | tee ".cloud-tests/verify-arctools/$stage/launch.log"
    ;;
  doctor|drive|cleanup)
    exec bun --no-env-file run .agents/skills/verify-arctools/scripts/probe.ts "$action" "$stage"
    ;;
  *) echo 'Use launch, doctor, drive, or cleanup' >&2; exit 1 ;;
esac
