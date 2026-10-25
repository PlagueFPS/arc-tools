# Public Twitch enrollment

A broadcaster authorizes `channel:bot` through the public Website, which calls Bot using an internal typed service binding. The environment account owns the session hashes, intent, membership, grants, subscription proof, alarm, limiter, and sends.

## Entry points and prerequisites

- Begin at `GET /oauth/twitch/enroll` on the Website origin, defaulting to `http://localhost:3000` outside production.
- Return through `GET /oauth/twitch/callback` in the same browser.
- Read only that installation at `GET /oauth/twitch/enroll/status` with its cookie.
- Use **Leave channel** on `/connect` to send an empty `POST /oauth/twitch/enroll/leave` with its cookie and exact canonical Origin.

Public enrollment requires a dedicated bot identity, an operator-resolved bot sender with valid sender grants, and webhook readiness. The personal local baseline and synthetic application environments reject enrollment. The root environment schema continues enforcing stage, application, and sender isolation. Live verification uses a separately configured real test application on a local bot profile with Website at localhost and a Bot HTTPS tunnel. Deployed staging OAuth defaults to localhost and needs a local Website instance connected to that Bot; alternatively configure a staging HTTPS Website origin. Follow the operator guide. Keep production on `prod` and reserve `test-*` for synthetic fixtures. Do not add request-selectable provider endpoints.

## Drive controlled journeys

Run from the repository root:

```bash
bun test packages/twitch/test/enrollment.test.ts packages/twitch/test/lifecycle.test.ts tests/website/enrollment.test.ts
```

The HTTP success journey uses the real account operations and `makeAccountStorage` adapter, with an external Provider fixture and signed raw EventSub bytes. It begins, accepts broadcaster authorization, inspects the persisted alarm deadline, runs repair after reconstruction, and requires a confirmed enabled observation before readiness. The fixtures control provider results, storage, and clock time. They do not set account state to claim an end-to-end success.

The account journeys cover denial, expiry, replay, session mismatch, client and user validation, scopes, admission at channel capacity, sender preservation, shared grants and limits, revision reauthorization, setup retaining membership, old snapshot decode, alarm recovery, unknown receipts, indefinite per-channel recovery, and revocation/reinstall. The HTTP negative journey also checks explicit non-mutating HEAD, Bot browser-route 404s, and operator callbacks without cookies. The RPC tests check serialized AccountError envelopes and unavailable bindings. The HTTP negative journey checks cookie bounds, duplicate query parameters, missing cookies, query-cookie rejection, and operator callbacks with unrelated or malformed enrollment cookies.

The cleanup journeys advance the controlled clock through the revocation window, reconstruct the account, and inspect the keyed channel records. They require scoped removal after `authorization_revoked` and `user_removed`, finite left replay, configuration vetoes, durable remote deletion, rejection of an expired callback, survival of unrelated memberships, and preservation of reauthorization before expiry. Tenant tests use the real storage adapter and verify `deleteAll()` after the last replay record expires. Review regressions cover revocation replays during timestamp skew and after tombstone expiry, `user_removed` found through reconciliation, and compatibility cleanup of legacy keyed records. Legacy records with active grants or without revocation proof must survive that pass.

These tests do not prove cloud deployment, native Cloudflare scheduling, real Twitch grants, live EventSub delivery, or grant survival after onboarding-token expiry. Retain their transcript separately from live proof.

## Drive an authorized live journey

1. Verify the exact stage, build revision, portal OAuth redirect, and callback origin. Prepare the dedicated sender through private operator setup.
2. Open `/oauth/twitch/enroll` in a fresh browser profile. Require an authorization request for `channel:bot` and approve as the intended broadcaster.
3. Require a 303 callback redirect to `/connect` and inspect `/oauth/twitch/enroll/status` in that profile. Record only the status and public login. Keep the cookie and redirect URL private.
4. Allow the account alarm to reconcile without polling status. After repair, require `ready` and an enabled confirmed subscription in private operator status.
5. Send `!sell sensors` in that broadcaster's channel. Observe exactly one threaded reply. Repeat the original signed delivery only through the controlled harness and require no duplicate send.
6. In another browser profile, require that status exposes no other installation or environment account details. With a valid pending authorization, reject a mismatched cookie without consuming the original intent.
7. Exercise denial and, when explicitly authorized, Leave, revocation, and fresh enrollment. Require stopped delivery after removal and restored readiness after renewal.
8. During an authorized temporary chat restriction, require `recovering`, retained grants, and persisted minute/five-minute/fifteen-minute retries. Require fresh enabled proof before new commands resume.
9. During Leave, reject missing or foreign Origin before Bot, retain the cookie, retry a lost response, and require the same finite `left` result. An old capability must not remove a reinstall.

Capture the feature ID, entry point, revision, public response, provider side effect, and unmet prerequisites. Do not capture cookies, state, authorization codes, user tokens, app tokens, or bearer credentials. A failed prerequisite is an unrun journey, not passing evidence.
