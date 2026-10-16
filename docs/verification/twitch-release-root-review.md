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

The root run finished with a setup failure at `GET /snapshot` on the probe, before any account tests. Stage `test-account-c0549d51-f81c46b1da18` recorded `testResult: 1` and `cleanupResult: 0`. Cleanup verified zero Workers and namespaces and absent stage state/output. After a narrowly classified readiness 404, the probe returned a fixture-marked JSON 500, ray `a4b36355cc45a10a-EWR`, 290 bytes, SHA-256 `69cf2d6a248ebc41793f2939161d0bc6c7d2947ea01d1bb48b9f3614e2bf9c98`. The terminal 500 was not retried.

Root therefore selected the diagnostic owner's proposed next experiment rather than another canonical run. A fresh isolated worker will trace actual bundled adapter construction and method-entry/rejection boundaries, alongside controls, with at most two new diagnostic deployments unless new evidence justifies more. It must preserve rejection, avoid shared dependency-cache mutation, and retain teardown verification. Native alarm behavior remains unverified. No application workaround or platform attribution is approved by these observations.

## Confirmed subscription correction received

The subscription owner returned regression `779755b`, implementation `bbd479e`, and evidence `b96620a` in `/home/angel/.t3/worktrees/arc-tools/t3-42e6847c`. Root read the evidence and provider, reconciliation, eligibility, observation, and fingerprint changes. Root independently ran default verification without Turbo cache hits. All 221 tests and 931 assertions passed. Forced build and typecheck passed all 11 tasks, root TypeScript checking passed, and direct Biome checking passed across 127 files.

The implementation removes subscription intents and records exact validated creation receipts. Conflict and uncertainty cannot create ownership. Reconciliation, status, and dispatch share the current-target decision. Observation input now requires the actual verified binding and callback, with one fingerprint helper shared by provider and account construction. The worker's two before-fix reproductions failed; their corrected scenarios now assert actual remote secret identity, no sends while unconfirmed, bounded repair calls, and preservation of persisted exact receipts.

Fresh comment review is running. Fresh technical reviews of this revision remain required. No cloud run was performed for this subscription revision while the shared native RPC failure remains under trace. These local results do not clear native alarm, signed-ingress, live-provider, or unit acceptance gates. The source checkout is clean and the root branch still contains only accepted foundation/cache application changes.

The subscription comment review has now completed with zero comments, suppressions, or required deletions. Fresh GPT-6.1-Sol and Gemini 3.8 Flash High technical reviews are running against `b96620a`, carrying both earlier counterexamples and the selected confirmed-ID contract.

## Traced RPC result and canonical comparison

The tracing owner returned clean commit `fbf524350d3c8d0a9750293e0aafcaa29353bf90` in `/home/angel/.t3/worktrees/arc-tools/t3-cbf5bff9`. Root read `docs/verification/native-rpc-trace.md`. The private bundle transformation preserves installed dependencies and application methods. Two actual diagnostic deployments each returned 200 for all 15 requests, including a cold probe path. Recorded construction and method boundaries succeeded. No earlier rejection reproduced, and some telemetry remains missing. This does not identify the original cause.

Both deployed diagnostic stacks contained five Workers and five SQLite namespaces, using native and minimal adapter controls in place of the canonical Bot/cache/Metaforge composition. Tracing adds observation Effects and Promise callbacks that can affect scheduling. The source-map text also retains the original bridge source, so transformed-source hashes and emitted marker checks are required to identify the instrumented upload artifact. The diagnostic records those distinctions rather than claiming plain-runtime equivalence.

There was also an initial private-copy planning failure before deployment. Its original failed cleanup journal remains retained; a separate successful cleanup check establishes zero Workers and namespaces and absent state/output. Both deployed stages also verified zero leftovers. No application or dependency fix was made.

Root selected a bounded plain-versus-traced comparison of the actual six-Worker canonical composition and its existing cold-probe trigger. It uses the latest confirmed-ID revision, retains the unchanged cloud business assertions, and includes the actual native credential alarm test if setup succeeds. The diagnostic owner may deploy at most two new disposable stacks for this pair. Each must preserve failure results and verify teardown. Historical source-version, private-copy, observability, and timing differences remain explicit experimental limits.

The two code reviews and this canonical comparison are active. There is still no passing canonical suite or observed native alarm result for the latest application revision. Unit 4 remains unaccepted and no application workaround has been selected.

## Confirmed-ID review recovery findings

GPT-6.1-Sol's review of `b96620a` passed the two original rotation reproductions but found two additional authorization-recovery defects. Root inspected the affected retirement, observation, and HTTP boundary paths and retains both as blockers. Gemini's review and the canonical comparison remain in progress.

Gemini's review has now returned a code pass with no findings. It agrees that the two original rotation cases are corrected. Its general assessment does not refute GPT-6.1-Sol's production-logic reproductions of retirement/revocation ordering and non-JSON 401 handling. Both assigned recovery corrections remain required. The canonical comparison continues separately.

When a list reports an exact confirmed current subscription as `authorization_revoked`, reconciliation retires and tombstones the ID without invalidating its grant facts. A later verified revocation is discarded because that same tombstone already exists. The reviewer reproduced repeated pending setup with no authorization links and both subjects still marked authorized after replacement failed with 403. Cleanup retirement is not evidence that the authorization-loss transition has already been applied.

The other reproduction returns HTML with HTTP 401 from `/users`. The shared HTTP helper tries to parse its body before the provider sees the status. Setup then receives a generic provider error and retains the rejected session. Two setup calls reused its generation and reported the credential as valid; returning JSON with the same status instead triggered the intended invalidation. The create adapter's earlier status-first fix does not cover this shared path.

A fresh isolated correction owner must preserve status authority across authenticated provider operations and model retirement separately from applied authorization revocation, using one idempotent grant-loss transition. Required tests include list-before-signed delivery, repeated delivery after reauthorization, current versus old verification context, unknown list entries, malformed error bodies, JSON success validation, and rate-limit handling. No broad 403 interpretation, retry policy, or confirmed-ID design change is implied. The fixed code still requires independent review and runtime verification.

## Canonical comparison and final authorization correction

The canonical comparison completed at diagnostic commit `dbf8cc2d5523f2c0a03632c5e6267d2b4aa77530` in `/home/angel/.t3/worktrees/arc-tools/t3-8179f8fb`. Both the plain stage `test-account-1e9cc916-22629b806c22` and traced stage `test-account-1e9cc916-73e293bf166b` passed all 15 cases and 243 assertions. Each used the actual six-Worker, six-namespace canonical composition with application sources equivalent to `b96620a`. Both passed the unchanged native credential alarm case, including reconstruction, lease recovery, and automatic alarm execution. Teardown verified zero Workers and namespaces and absent stage state/output for both deployments.

These results supersede the earlier statement that no canonical native alarm execution had passed on the confirmed-ID revision. Historical RPC rejection remains unexplained. The successful plain run establishes that tracing was unnecessary in that execution. Stage, time, and private-copy differences prevent attributing historical recovery to a single cause. No application workaround is proposed. Root read the comparison report; its diagnostic archive remains isolated rather than imported into the application.

The authorization correction completed in `/home/angel/.t3/worktrees/arc-tools/t3-d02f27e1`. Commit `f0e4f07` adds both failing reproductions, `c00f654` applies the correction and expands coverage, and `2dc1696` records evidence. Tagged tombstones distinguish cleanup retirement from applied revocation. One grant-loss transition fences stale operations and preserves fresh grants on duplicate delivery. The shared HTTP boundary preserves explicit rejection status before optional error-body parsing, with JSON 429 handling retained. Public account and observation contracts remain unchanged.

Root independently ran the unchanged default test command without Turbo cache hits. All 243 tests and 1,021 assertions passed. The existing 221 cases remain alongside 22 new regressions. Fresh comment review is active. Forced build, typecheck, and lint are running separately. Root also started one normal, untraced canonical cloud run on this final correction, stage `test-account-dd3390ab-e27cf12ff98f`, logged at `/tmp/arc-authorization-root-cloud.log`. Its result and teardown remain pending. The new revision and successful plain canonical comparison justify this verification run; failures remain terminal under the unchanged strict harness.

The read-only Unit 3 handoff identified the existing account, cache, command, and verified-observation seams. Signed routes, tenant state, controlled provider wiring through the Bot, and a valid synthetic Discord signing key still belong to Unit 3. No next-unit application code has been delegated before Unit 4 acceptance. Fresh technical reviews and root cloud verification remain required.

Root's final-revision canonical execution has now completed successfully. Stage `test-account-dd3390ab-e27cf12ff98f` passed all 15 tests and 243 assertions without tracing or application changes. The native account alarm reconstruction and credential lease recovery case passed. The runner recorded `testResult: 0` and `cleanupResult: 0`; cleanup independently listed zero Workers and Durable Object namespaces, absent stage state/output, and the retained control backend. Console evidence remains `/tmp/arc-authorization-root-cloud.log`; the disposable run journal is `.cloud-tests/test-account-dd3390ab-e27cf12ff98f/result.json` in the candidate checkout.

Forced root build passed four tasks, workspace typechecking passed seven tasks followed by root TypeScript, and lint checked 129 files. All had zero Turbo cache hits. The fresh comment review scanned all nine correction paths and found zero comments to delete, suppressions, or reshape flags. Fresh GPT-6.1-Sol and Gemini 3.8 Flash High technical reviews are now active as `cloudflare-authorization-review-a-r4` and `cloudflare-authorization-review-b-r4`. Their briefs include the earlier defects, selected ownership model, final correction, and independent runtime results. Acceptance and application integration remain held for those results; no additional cloud rerun is needed unless a source change or new finding justifies one.
