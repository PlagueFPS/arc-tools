# Provider extraction verification

The backend changes prepare shared packages and public Twitch enrollment. Website integration and its technology choice remain deferred. Command examples contain invocations only.

## Checks

The final source passed `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run test`, in that order. The test run passed 492 tests. `bun run build` and `git diff --check` also passed after the corrections. Final correction logs are retained under `/tmp/arc-site-implementation/final-findings-*.log` in this workspace. The final build log is `/tmp/arc-site-implementation/final-reviewed-build.log`.

Browser bundle checks cover the command catalog and Discord install helper. Existing provider, subscription ownership, send deadline, replay, and registration tests run through the new package imports.

## Review corrections

The first two final reviewers, Codex and Gemini, returned no findings. Grok identified public-channel revocation affecting shared authorization, an enrollment exchange lease shorter than the possible provider calls, and an ambiguous capacity error in setup. All three were corrected, with eight additional regressions and renewed ordered checks.

A fresh targeted Gemini review of those corrections returned no findings. It also verified that the correction patch adds no code comments. Its trail review retained the live-provider caveat; the final cloud result is recorded below and supersedes earlier pending entries in the append-only decision trail.

Public-only members now have scoped revocation sequences. Intents capture the current sequence when they begin. A revoked member's older callback cannot restore its grant, while unrelated pending and in-flight callbacks remain valid. Revocation clears the active setup lease to fence old reconciliation results. Configured channels and the sender retain the previous conservative authorization behavior.

The exchange has a 14-second total budget, starting when its storage claim is acquired. The public HTTP callback allows 16 seconds, while operator OAuth keeps its 12-second timeout. Controlled-clock tests exercise slow valid calls, total deadline cancellation, and delayed completion. These are correctness checks, not measured live latency.

Setup reports capacity as HTTP 409 without replacing stored channels or silently evicting public members. There is no member removal API in this scope. Configuration or a separately reviewed maintenance procedure must resolve a full account.

The bounded eight-intent, ten-minute public admission policy remains. An unauthenticated client can temporarily consume that budget. Replacing a shared outstanding intent for visitors without a cookie would allow cross-user eviction, so that proposed mitigation was rejected. The current limits protect storage and existing bot delivery, but do not provide abuse-resistant public signup admission.

Persisted production public memberships initially remained active after a transition to a personal or synthetic environment. Both transition tests failed before the correction. All membership consumers now require the current environment kind. Public memberships remain stored but dormant outside production, and returning to production requires renewed authorization.

Repair claims now carry an explicit operation ID. A held provider operation verifies that an old completion cannot replace a newer enrollment's repair schedule. Retries preserve the ID.

The first cloud run exposed an enrollment Durable Object lookup during stack evaluation. The enrollment binding now defers that lookup until request runtime, matching the account binding. Recovery for stage `test-tenant-34100edf-29821d03e942` verified zero remaining Workers, namespaces, stage state entries, and output.

## Local Worker proof

Stage `local-verify-enrollment-20261021105906-136543` passed health identity checks, signed Discord PING, invalid-signature rejection, and private DM rejection through the real local workerd listener. Enrollment begin returned 503 in this personal environment. Status without a cookie returned 401. Neither response set a cookie. Both carried `no-store` and `no-referrer` headers.

The stage was stopped and cleanup passed. Evidence remains in `.cloud-tests/verify-arctools/local-verify-enrollment-20261021105906-136543/`, including `enrollment-access.json` and the five standard verification artifacts.

## Remaining live-provider proof

The disposable cloud suite passed 28 tests after the final corrections in stage `test-tenant-34100edf-86c248b39762`. It exercised all ten commands through deployed bot routes on both transports, native account storage and alarms, OAuth validation, subscription proof, shared limits, deadlines, recovery, and revocation against controlled providers. Test and cleanup both exited zero. Cleanup verified zero remaining stage Workers, namespaces, state entries, and output. Journals remain in `.cloud-tests/test-tenant-34100edf-86c248b39762/`; the transcript is `/tmp/arc-site-implementation/final-cloud-reviewed.log`. The earlier successful extraction run remains recorded in stage `test-tenant-34100edf-b96c3de7d30a`.

Controlled enrollment tests exercise real account operations and the HTTP router with fixture provider responses. They cover session binding, denial, replay, capacity, durable repair, confirmed subscription readiness, revocation, environment transitions, and revision reauthorization.

The new public enrollment repair path was tested with controlled account/storage fixtures, rather than a production enrollment on native Cloudflare scheduling. Real Twitch OAuth approval, grant behavior after token expiry, EventSub callbacks, chat delivery, and Discord client installation remain unverified. Follow the public enrollment journey in the verification skill with explicitly authorized provider applications before treating these as live-provider proof.
