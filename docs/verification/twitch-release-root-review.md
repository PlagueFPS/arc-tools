# Account and release root review

Unit 4 is not accepted or integrated. Root reviewed commit `4988f00b5d3ffe53abff89f6331ff1bb8f82b6dd` in `/home/angel/.t3/worktrees/arc-tools/t3-5b69d597`. Independent technical reviews and a cloud harness correction are pending.

## Local verification

Root ran the full local suite with Bun 1.3.5. All 181 tests passed with 580 assertions across 24 files. Forced build and typecheck passed all 11 tasks without cache hits. Root TypeScript checking, a direct Biome check of 119 files, frozen installation, and diff whitespace checks passed.

The comment reviewer inspected all 27 changed paths and found no comments, suppressions, or required deletions. Independent GPT-6.1-Sol and Gemini 3.8 Flash High technical reviews are still running. They cover account authorization and concurrency, safe send outcomes, registration reconciliation, release fencing, and fixture fidelity.

## Independent cloud run

Root ran `bunx bun@1.3.5 run scripts/cloud-test.ts account`. Stage `test-account-a0e65c16-56ec6e796e36` finished with 11 passing tests, three failing tests, and 203 assertions. All six new account and release tests passed. The failed run is retained rather than replaced by an unchanged rerun.

The failures were in existing foundation and cache checks:

- The reconstruction assertion observed the original instance UUID after an unchecked `POST /reset`. A later read-only probe observed a new UUID with the committed value intact. The failure does not establish whether the reset request missed the route or reconstruction had not completed at the first observation.
- The alarm test received a 404 HTML response from `POST /arm` and attempted to parse it as JSON.
- The first cache test exhausted its bounded `FixtureRouteNotReady` retries. The remaining four cache cases passed.

The harness currently treats readiness inconsistently between reads and mutations. Root delegated a narrow diagnosis and correction. It must check mutation responses, distinguish infrastructure readiness from executed business failures, and retain strict reconstruction, rollback, alarm, and cache assertions. Blanket test retries and weaker assertions are not an acceptance path.

The run deployed six Workers and six SQLite Durable Object namespaces. Teardown verified zero matching Workers and namespaces, no stage state entries, and no stage output. The shared control backend was retained. The run journal records `testResult: 1` and `cleanupResult: 0`. Journals are under `.cloud-tests/test-account-a0e65c16-56ec6e796e36/` in the reviewed worktree. Root's captured console output is `/tmp/arc-account-root-cloud.log`.

## Remaining gates

Inspect the independent technical findings, review the harness correction, and independently rerun the corrected cloud suite before acceptance. Live provider grants after onboarding-token expiry, signed EventSub delivery, chat timing, Discord registration/privacy/timing, CI environment configuration, and operating cost remain unverified. Signed ingress is unit 3; legacy deletion and final composition are unit 5.
