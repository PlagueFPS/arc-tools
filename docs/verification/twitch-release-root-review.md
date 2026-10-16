# Account and release root review

Unit 4 is not accepted or integrated. Root reviewed commit `4988f00b5d3ffe53abff89f6331ff1bb8f82b6dd` in `/home/angel/.t3/worktrees/arc-tools/t3-5b69d597`. Both technical reviews are complete. Account corrections and a cloud harness correction are in progress.

## Local verification

Root ran the full local suite with Bun 1.3.5. All 181 tests passed with 580 assertions across 24 files. Forced build and typecheck passed all 11 tasks without cache hits. Root TypeScript checking, a direct Biome check of 119 files, frozen installation, and diff whitespace checks passed.

The comment reviewer inspected all 27 changed paths and found no comments, suppressions, or required deletions. Independent GPT-6.1-Sol and Gemini 3.8 Flash High technical reviews cover account authorization and concurrency, safe send outcomes, registration reconciliation, release fencing, and fixture fidelity. Their findings are assessed below.

## Technical review synthesis

The intent is an environment-bound account owner with recoverable credentials, idempotent subscription setup, bounded safe dispatch, and release-time command reconciliation. The reviews assess that implementation. Signed ingress and legacy deletion remain later units.

### Act on

GPT-6.1-Sol reproduced six blocking defects. Root inspected the supporting paths. The account correction delegate owns all six and the repeated-setup case independently identified by Gemini.

| Area | Finding | Required correction |
| --- | --- | --- |
| Credential recovery | A reconstructed object with a session and an active token lease can finish its alarm without scheduling another native alarm. | Preserve the next credential action across a consumed alarm and lease contention. Verify the actual alarm handler. |
| Credential generation | A late validation response can restore a token invalidated by a concurrent send's 401. | Fence validation against invalidation of its source session. |
| Setup repair | A 401 from `/users` leaves the rejected session cached as valid. | Apply generation-aware invalidation throughout setup. |
| Subscription binding | A remote create that succeeds before an interrupted response can be adopted under a later signing-secret binding. | Persist enough binding intent before mutation to prevent false adoption after repeated rotation. |
| Registration drift | Global command GET omits full localization dictionaries, so localization drift can be invisible. | Request complete localizations for both comparison and readback, with provider-faithful tests. |
| OAuth capacity | A distinct sender and 32 broadcasters require more states than the current bound permits. Repeated setup also accumulates states until capacity is exhausted. | Allocate bounded states by current authorization subjects and make repeated setup usable. |

Discord documents `with_localizations` as false by default. [Get global application commands](https://docs.discord.com/developers/interactions/application-commands#get-global-application-commands). Cloudflare documents that a running alarm has no next scheduled alarm unless the handler schedules one, and warns that constructor scheduling can interfere with an existing alarm. [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

### Consider

Gemini identified a real launch limit. The account retains at most 64 attempt records until ten minutes after their deadlines. Further attempts can encounter capacity before the remote rate limit. This bounded rejection is not a violation of the 20-per-30-second safety limit, which is a maximum rather than a throughput promise. The agreed launch is a few quiet channels. Retain the bound for now and include it in the final launch-capacity assessment. Do not lower the shared retention constant indiscriminately because it also controls revoked-subscription tombstones.

### Noted

The cloud provider fixture creates subscriptions already enabled. Pure tests cover an enabled observation racing a stale pending list. Signed challenge-to-notification behavior remains a required unit 3 and live-provider gate. No claim of full webhook lifecycle verification follows from unit 4's fixtures.

Malformed authenticated operator input currently produces a sanitized 503 rather than a 400. Gemini identified this API distinction. It does not invalidate the bounded, authenticated operation or require expanding this correction wave.

### Dismissed

Gemini recommends changing the manifest's omitted `required` default to match the old Discord adapter. All existing registry options explicitly set `required: true`, so the alleged present behavior regression does not occur. The obsolete adapter is removed in unit 5. Changing the new default solely to match that adapter adds no current guarantee.

### Agreement and disagreement

Both models identified OAuth state capacity and repeated-setup problems. Gemini's general pass assessments for credential recovery and secret rotation do not refute GPT-6.1-Sol's specific interleaving reproductions. Those defects remain blockers. Comment review is clear. No reviewer verdict substitutes for root runtime checks.

Both correction tasks initially stopped at a provider usage limit. On 2026-10-15 at approximately 20:31 UTC, root verified that T3 had automatically resumed both tasks in their existing isolated worktrees. The harness checkout contains unfinished test-only edits; the account checkout contains the imported unit 4 implementation. Neither task is accepted as completed, and no duplicate writer was started.

## Independent cloud run

Root ran `bunx bun@1.3.5 run scripts/cloud-test.ts account`. Stage `test-account-a0e65c16-56ec6e796e36` finished with 11 passing tests, three failing tests, and 203 assertions. All six new account and release tests passed. The failed run is retained rather than replaced by an unchanged rerun.

The failures were in existing foundation and cache checks:

- The reconstruction assertion observed the original instance UUID after an unchecked `POST /reset`. A later read-only probe observed a new UUID with the committed value intact. The failure does not establish whether the reset request missed the route or reconstruction had not completed at the first observation.
- The alarm test received a 404 HTML response from `POST /arm` and attempted to parse it as JSON.
- The first cache test exhausted its bounded `FixtureRouteNotReady` retries. The remaining four cache cases passed.

The harness currently treats readiness inconsistently between reads and mutations. Root delegated a narrow diagnosis and correction. It must check mutation responses, distinguish infrastructure readiness from executed business failures, and retain strict reconstruction, rollback, alarm, and cache assertions. Blanket test retries and weaker assertions are not an acceptance path.

The run deployed six Workers and six SQLite Durable Object namespaces. Teardown verified zero matching Workers and namespaces, no stage state entries, and no stage output. The shared control backend was retained. The run journal records `testResult: 1` and `cleanupResult: 0`. Journals are under `.cloud-tests/test-account-a0e65c16-56ec6e796e36/` in the reviewed worktree. Root's captured console output is `/tmp/arc-account-root-cloud.log`.

## Remaining gates

Review the six account corrections and the harness correction, then independently rerun the corrected local and cloud suites before acceptance. Live provider grants after onboarding-token expiry, signed EventSub delivery, chat timing, Discord registration/privacy/timing, CI environment configuration, and operating cost remain unverified. Signed ingress is unit 3; legacy deletion and final composition are unit 5.

## Harness correction received

The harness worker returned `f4e57261807087d231ab4a41a6f981245f709fee` in `/home/angel/.t3/worktrees/arc-tools/t3-d1243984`. It changes tests and evidence only. Root read the shared HTTP boundary, reconstruction acknowledgement, changed callers, and evidence. Root independently ran 189 local tests with 653 assertions, including eight new harness regressions. Root TypeScript checking and a direct Biome check passed.

The correction classifies only a precise missing-Worker HTML response as pre-execution readiness failure. Classification requires a disposable test hostname, 404, HTML content type, Cloudflare server header, no fixture response marker, and the exact observed body SHA-256. It retries within a bounded request budget. Fixture errors, other 404s, 500s, redirects, unknown transport execution, parsing failures, and schema failures stop. Reconstruction acknowledgement accepts only the expected native abort error. The UUID observation polls a bounded condition while retaining the persisted-state and alarm assertions.

The worker's final cloud stage `test-account-15e5217e-e077475f24a3` records 14 passes and 222 assertions with verified teardown. It captured the exact missing-Worker response on several GET and POST fixture routes between successful responses. This supports the narrow readiness classification. It does not prove what caused the original unchecked reset failure. The lower assertion counter moves repeated HTTP checks into a fail-fast decoder; root's technical review must still confirm that domain assertions remain intact.

Fresh technical and comment reviews of the harness patch passed its runtime behavior and comment scope. The technical reviewer found one material gap: default verification omitted all eight helper regressions. A separate delegate corrected that gap in `29c42db35a1eaf9f3701639df6f09184e46fde5b` in `/home/angel/.t3/worktrees/arc-tools/t3-c46f2daa`. The root `test` script now runs the two exact helper suites after workspace tests, outside Turbo caching. Existing CI and release workflows inherit the command.

Root inspected the one-line script change and independently ran `TURBO_FORCE=true bunx bun@1.3.5 run test`. Six uncached workspace tasks ran all 181 existing tests, followed by eight helper tests under Bun 1.3.5. All 189 tests and 653 assertions passed. The correction changes only the root script and its evidence document. No cloud deployment was needed to verify discovery.

Root will run the real-cloud suite after combining the reviewed harness and account corrections. Running the same cloud suite before those account changes would not verify the pending account fixes. The account corrections and combined acceptance gate remain open.

## Account corrections received

The account worker returned regression commit `165a0d6` and correction commit `90231bd` in `/home/angel/.t3/worktrees/arc-tools/t3-8c90ffc4`. Root read the correction evidence and production diff, then independently ran all 192 local tests with 701 assertions. All passed. The correction adds eleven local regressions while preserving the original 181 tests and ten command fixtures.

The changes fence credential validation against an explicit 401, invalidate rejected setup credentials, persist subscription binding intent before creation, allocate OAuth batches atomically within derived capacity, request full Discord localizations, and synchronize native alarms with their persisted intent. A new fixture case exercises the actual credential alarm after native reconstruction. It has not yet run on Cloudflare in this correction branch.

A fresh integration owner is combining the original unit, harness, default-test discovery, and account corrections in an isolated checkout. Root identified that the newly added native reconstruction route still suppressed all abort causes in the account-only branch. The active integrator received a clarification to apply the already-required exact abort acknowledgement to that new route as well. Combined cloud evidence and fresh reviews remain required. No account correction has been accepted or integrated into root.

## Combined revision and cloud blocker

The integration owner returned clean revision `d4d0c301dfd65f38a82b49fc9e067c22449e3259` in `/home/angel/.t3/worktrees/arc-tools/t3-5a5c9834`. The import history, single resolved import conflict, strict native reconstruction acknowledgement, and test-only error logging are recorded in `docs/verification/account-integration.md` there. Application runtime files remain identical to the account correction revision. Root independently ran the default test command without Turbo cache hits. All 200 tests and 774 assertions passed under Bun 1.3.5.

Combined cloud verification did not pass. The integration owner retained four failed disposable stages, all prefixed `test-account-c0549d51-`, and verified cleanup for each. The canonical run failed at the first probe snapshot. Later focused diagnostics reached failures in the unchanged foundation probe and the controlled provider's native RPC. The actual native alarm case failed at preparation before reconstruction or alarm execution. No success claim follows from its execution being attempted.

The final diagnostic retained Cloudflare internal-error references `htgsvhb12pe6qtbdq0830bgb` for the probe and `2nju2gercivdhg17tjmf7u7v` for the controlled provider request. These observations locate a native RPC failure but do not identify its cause or establish an account-policy defect. The integration owner's instrumentation error in the third stage is separately recorded and does not count as evidence of the original cause.

Root delegated a fresh diagnosis with the explicit hypothesis that the shared failures might not arise from account recovery logic. Before proposing another fix, the diagnostic must produce a rerunnable census of actor, route, class, method, construction, and failure evidence. Experiments use the smallest disposable stack that can distinguish an application, adapter, deployment, or platform cause. Whole-suite retries and broad HTTP 500 retries remain excluded.

The combined correction needs fresh technical and comment reviews. The shared RPC failure, native alarm recovery, and a passing canonical combined cloud run remain blocking gates. All application changes remain outside the root branch until acceptance.

## Combined review findings

The combined comment review found no comments or suppressions to remove. Gemini's second technical review returned a code pass. GPT-6.1-Sol's second review reproduced two subscription defects using the production account logic and create adapter. Root inspected the corresponding reconciliation, status, and dispatch paths and retains both as blockers.

First, an unresolved create under binding B can become visible only after rotation to C and after C's list requests. C overwrites the channel intent, its create receives 409, and readback attributes B's remote subscription to intent C. The current adapter treats 202 and 409 alike. The reviewer observed remote binding B, stored binding C, and no deletion; repeated setup preserved the mismatch. A current intent proves what was requested, not which signing secret an existing remote ID uses.

Second, configuration replacement retains old enabled subscription records for cleanup. After completing the new authorization links but before a second reconciliation, status reports ready and dispatch sends against the old binding. Both paths check enabled status without requiring the current binding, callback, and sender. Retained cleanup records must not grant readiness or delivery eligibility.

The general code pass does not refute these specific reproductions. The remaining credential, OAuth allocation, and localization corrections are not rejected by these findings. The next correction is scoped to subscription ownership and one shared eligibility decision.

Root launched two read-only architecture sketches before another implementation patch. Candidate A examines confirmed subscription IDs and conservative replacement of unknown bindings. Candidate B examines bounded unresolved-operation history across rotations. Each must show what evidence establishes remote ownership, distinguish confirmed creation from conflict, and trace both reproduced races. The selected shape must eliminate false certainty rather than add another check around the latest-intent assumption.

The native RPC diagnosis initially stopped at a provider usage limit. Root verified its second run is active after T3 automatically resumed it. No duplicate diagnostic worker or additional blind cloud run was started. The cloud failure cause remains unresolved; a reviewer calling it an upstream issue does not establish that attribution.

## Native RPC diagnostic result

The diagnostic owner returned clean commit `c3d7f5d7d44df04cc57063f5e7206542d23b124e` in `/home/angel/.t3/worktrees/arc-tools/t3-17ca057e`. Root read `docs/verification/native-rpc-diagnosis.md`. The diagnostic changes contain isolated tools and evidence, with no application fix.

The original preparation call reached the controlled provider's native request RPC before failing. The native lease installation and alarm assertions had not run. An independent unchanged probe failed at another native RPC. That evidence rejects account recovery as a shared explanation, without identifying an adapter or platform cause.

The new diagnostic had one planning failure without deployed resources and two deployments. The first deployment passed native and minimal Alchemy controls but failed five original fixture native calls; later HTTP paths worked. The later deployment reversed order and included fresh identities, and all 13 requests passed. More than four hours separate these deployments. Caller path, activation time, and environmental state were not independently controlled, so no call-order or outage explanation is established. All diagnostic cleanup checks reported zero Workers and namespaces and absent stage state/output.

The later successful native controls provide new evidence that justifies one fresh canonical account-suite execution. Root started that run on unchanged combined revision `d4d0c30`, retaining the strict harness, without HTTP 500 retries, warm-up steps, sleeps after deployment, or an application workaround. Its console is `/tmp/arc-combined-root-cloud-recovery.log`. This execution cannot clear the separate subscription ownership findings. Its result and cleanup remain pending.
