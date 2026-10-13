# Worker review

The independent reviewers were GPT-6.1-Sol and Gemini 3.8 Flash High. They reviewed the migration before publication. Comment Sicko found no comments or suppressions to delete. A fresh implementation delegate hit model capacity, so the parent applied the review fixes.

## Accepted findings

Twitch 429 responses can supply `Ratelimit-Reset` without `Retry-After`. The old client returned zero delay and consumed attempts before the reset. The corrected client takes the longer bounded delay. Local HTTP fixtures cover reset-only, combined, malformed, expired, and distant reset headers. A real workerd test checks the persisted wake time. Both the HTTP case and workerd case failed against the old code.

Twitch list pages can repeat a subscription ID. The old reconciliation compared object identity, deleted the selected keeper's second copy, and skipped creation. The corrected collection uses a map keyed by ID and compares keeper IDs. Local HTTP tests check zero writes for a repeated enabled subscription and one delete plus one create during explicit recreation. Both cases failed against the old code.

The EventSub list endpoint does not support `first`. Requests now use only `after` when a cursor exists. The fixture asserts both first-page and subsequent-page URLs. See [Twitch API concepts](https://dev.twitch.tv/docs/api/guide/).

OAuth token types are case-insensitive. The decoder accepts case variants of `bearer` and rejects other schemes. Workerd tests use `Bearer` and `Basic`. The valid case failed against the old decoder. See [OAuth successful responses](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1).

The deployment bundle and local verification now import the same compatibility constant. The owner fixed this before the review completed. Duplicate body-length guards were removed because the stream reader already enforces the cap.

## Review responses

The suggestion to retain raw upstream error bodies is declined. Such bodies can contain credentials. Job logs retain the delivery ID, attempt, HTTP status, and retryability. The provisioning CLI deliberately avoids printing raw causes. This limits troubleshooting detail.

Cross-channel reconciliation uses separate Twitch API mutations. A rollback would introduce more external mutations without creating atomicity. Rerunning reconciliation converges on the configured subscriptions. The README documents partial failures and reruns.

The temporary branded-schema type error was fixed by retaining both type parameters in `Schema.Codec<A, I>`. The final type check verifies the corrected boundary.

## Trail corrections

The decision trail is append-only. New rows close the pending fixture correction, response schemas, and body cap. New rows also record the CI runtime pins, Twitch isolation coverage, no-comments review, critical reproductions, and review responses. The architecture document replaces the temporary design report as persistent evidence.

Live Cloudflare deployment, Twitch authorization, Discord endpoint registration, and account provisioning remain outside the local verification. Twitch sends retain the documented crash window between remote success and local completion. A reply can repeat after a crash in that window.

## Final review

Gemini 3.8 Flash High reviewed the corrected code and the append-only trail against root transcript positions 265 through 334. The reviewer confirmed that the accepted findings are closed and that the final verification counts match the actual runs. The Attention verdict has no flags. The live-account limits above remain documented constraints.
