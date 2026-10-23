# Public Twitch enrollment

A broadcaster authorizes `channel:bot` through the existing bot Worker. The environment account owns the session hashes, intent, membership, grants, subscription proof, alarm, limiter, and sends.

## Entry points and prerequisites

- Begin at `GET /oauth/twitch/enroll` on the configured HTTPS origin.
- Return through `GET /oauth/twitch/callback` in the same browser.
- Read only that installation at `GET /oauth/twitch/enroll/status` with its cookie.

Public enrollment requires a dedicated bot identity, an operator-resolved bot sender with valid sender grants, and webhook readiness. The personal local baseline and synthetic application environments reject enrollment. The root environment schema continues enforcing stage, application, and sender isolation. Live verification uses a separately configured real test application on a local bot profile through an HTTPS tunnel, or the deployed staging bot profile. Follow the operator guide. Keep production on `prod` and reserve `test-*` for synthetic fixtures. Do not add request-selectable provider endpoints.

## Drive controlled journeys

Run from the repository root:

```bash
bun test packages/twitch/test/enrollment.test.ts apps/bot/test/enrollment.test.ts
```

The HTTP success journey uses the real account operations and `makeAccountStorage` adapter, with an external Provider fixture and signed raw EventSub bytes. It begins, accepts broadcaster authorization, inspects the persisted alarm deadline, runs repair after reconstruction, and requires a confirmed enabled observation before readiness. The fixtures control provider results, storage, and clock time. They do not set account state to claim an end-to-end success.

The account journeys cover denial, expiry, replay, session mismatch, client and user validation, scopes, admission at channel capacity, sender preservation, shared grants and limits, revision reauthorization, setup retaining membership, old snapshot decode, alarm recovery, unknown receipts, bounded retry, and revocation/reinstall. The HTTP negative journey checks cookie bounds, duplicate query parameters, missing cookies, query-cookie rejection, and operator callbacks with unrelated or malformed enrollment cookies.

These tests do not prove cloud deployment, native Cloudflare scheduling, real Twitch grants, live EventSub delivery, or grant survival after onboarding-token expiry. Retain their transcript separately from live proof.

## Drive an authorized live journey

1. Verify the exact stage, build revision, portal OAuth redirect, and callback origin. Prepare the dedicated sender through private operator setup.
2. Open `/oauth/twitch/enroll` in a fresh browser profile. Require an authorization request for `channel:bot` and approve as the intended broadcaster.
3. Require a bounded JSON callback response and inspect `/oauth/twitch/enroll/status` in that profile. Record only the status and public login. Keep the cookie and redirect URL private.
4. Allow the account alarm to reconcile without polling status. After repair, require `ready` and an enabled confirmed subscription in private operator status.
5. Send `!sell sensors` in that broadcaster's channel. Observe exactly one threaded reply. Repeat the original signed delivery only through the controlled harness and require no duplicate send.
6. In another browser profile, require that status exposes no other installation or environment account details. With a valid pending authorization, reject a mismatched cookie without consuming the original intent.
7. Exercise denial and, when explicitly authorized, revocation and fresh enrollment. Require stopped delivery on revocation and restored readiness after renewal.

Capture the feature ID, entry point, revision, public response, provider side effect, and unmet prerequisites. Do not capture cookies, state, authorization codes, user tokens, app tokens, or bearer credentials. A failed prerequisite is an unrun journey, not passing evidence.
