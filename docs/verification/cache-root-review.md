# Cache root review

Unit 2 remains blocked by the command deadline defect below. Root independently checked the implementation at `7473b7e` in `/home/angel/.t3/worktrees/arc-tools/t3-3c977d3b`. The implementation has not been integrated into the root branch.

## Verified checks

On 2026-10-15, root ran Bun 1.3.5 against the utility, data, command, legacy transport, and new bot test directories. All 149 tests passed with 377 assertions. Forced Turborepo build and typecheck passed all 11 tasks without cache hits. Root TypeScript checking passed. Lint passed with 102 files checked, replaying the existing successful Turborepo lint result.

Root ran `bunx bun@1.3.5 run scripts/cloud-test.ts cache` against real Cloudflare resources with the default deployment profile. Stage `test-cache-b77ec867-49eec1f5fa0c` passed all eight tests and 148 assertions. These cover raw HttpApi bytes, storage rollback and reconstruction, alarm retries, cache serialization, freshness boundaries, failed-refresh cooldown, schema failures, concurrency, generation fencing, and distinct request keys.

The run created four Workers and three Durable Object namespaces. Cleanup verified zero remaining test Workers, zero test namespaces, no stage state entries, and no stage output. The shared control backend was retained. The run journal recorded `testResult: 0` and `cleanupResult: 0` under `.cloud-tests/test-cache-b77ec867-49eec1f5fa0c/` in the reviewed worktree.

The cloud fixtures use an injected clock and an extended upstream timeout for controlled concurrency. These results establish cache behavior and Cloudflare persistence. They do not establish live bot response timing.

## Review results

Gemini 3.8 Flash High found no defects in the cloud adapters, fixture isolation, readiness handling, resource tracking, or teardown. Comment Sicko found no added or modified comments, suppressions, or recommended deletions across the implementation diff.

The GPT-6.1-Sol core review found a blocking absolute-deadline defect in `packages/commands/src/execute.ts`. The relative Effect timeout can return success after the deadline when synchronous work delays its timer callback. Root reproduced the defect with a read-only Bun probe. A source fixture performed 100 milliseconds of synchronous work; `sell sensors` with a deadline 20 milliseconds ahead returned `Success` after that deadline.

A fresh isolated implementation delegate owns the fix and deterministic regression tests. Required behavior is to retain the asynchronous timeout and check the absolute clock before returning success. A late result must fail with `CommandError`, whose cause is `DataUnavailable` for resource `command` and reason `deadline`, preserving accumulated stale provenance.

## Remaining gates

Review and independently verify the fix before accepting or integrating unit 2. GitHub cloud-test credential configuration remains unverified. Live Twitch and Discord behavior, privacy, response timing, command synchronization, and operating cost remain outside this unit's verified scope.
