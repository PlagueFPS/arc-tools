# Tenant and ingress root review

Unit 3 is NOT ACCEPTED. Root has received candidate `0c5caa6` in `/home/angel/.t3/worktrees/arc-tools/t3-7f6f398d`. Its application code matches deployed revision `3a4ac15`. The candidate commits are `6731049`, `55e012b`, `3a4ac15`, and `0c5caa6`, based on accepted root `d22e51a`. No candidate application changes are integrated.

## Received evidence

The owner reports 273 passing local tests and 1,239 assertions, forced build/typecheck/lint, and three failed disposable cloud deployments. Root read the complete `docs/verification/tenant-ingress.md` and inspected the changeset and runtime composition, tenant storage/state transitions, Discord response path, and cache binding. Owner results do not replace root checks or independent reviews.

The final stage `test-tenant-d7f33821-b385fd6e4cef` passed 23 cases and failed four with 352 assertions. All 15 inherited canonical cases passed. New passing cases included useful cold Discord execution, native Tenant recovery, account completion loss without a second POST, concurrent Discord duplicates, interrupted activation, and multipart ambiguity. The stage's cleanup verified zero Workers, zero namespaces, and absent stage state/output. Previous failed runs and cleanup journals remain retained. No fourth deployment has been authorized yet.

Two unexpected private responses block acceptance. A warm Discord request failed after 19 milliseconds of application time, and a subsequent `loot` command failed after 13 milliseconds. These are useful-path failures, not evidence of good latency. Earlier failures stopped full ten-command cloud coverage and produced fewer timing samples than the final assertion required. That timing-count failure is downstream evidence, not an independent latency regression.

The allocation case expected namespace listing to reveal the first cold tenant, but the provider API returned zero objects through its bounded poll. Its evidence did not establish whether that listing can prove allocation visibility for these SQLite objects. The negative ingress requests were initially skipped by that assertion; the final diagnostic commit moves them earlier and retains the token-free Worker fallback header. Those diagnostic changes have not run on cloud. Root will not accept an invisible listing as proof that no tenant work occurred.

The owner recorded useful cold replies and expected slow-source private errors below three seconds in that run. Complete warm and ten-command gates remain NOT VERIFIED. Live-provider timing, privacy, token expiry, and operating cost remain separate gates. No platform cause or new retry policy is inferred.

## Root verification and investigation

Root started the unchanged default local suite under pinned Bun 1.3.5 without Turbo cache hits, logged at `/tmp/arc-tenant-root-tests.log`. Fresh read-only comment review is active as `cloudflare-tenant-comments-r1`. A separate read-only diagnosis, `cloudflare-tenant-fast-failure-diagnosis-r1`, is tracing the exact private-response boundary, runtime clients and cache behavior, fixture queries, and allocation proof. It may run local probes but cannot edit or deploy. A fix owner will be assigned after concrete evidence identifies the correction.

Fix Root Causes requires distinguishing Worker RPC fallback from a Tenant-committed private response before compensating for the visible error. Guard the Context Window keeps the full trace and fixture inspection in a scoped delegate while root retains the causal findings. No source workaround, business retry, new cloud run, or implementation acceptance follows from this handoff.

Root's uncached default suite completed successfully with all 273 tests and 1,239 assertions, including the eight strict cloud HTTP helper cases outside Turbo. The fresh comment review scanned all 28 changed paths and found zero added/modified comments, suppressions, deletions, or reshape flags. These clear the local and comment gates only. Technical review, causal resolution of failed useful cloud replies, the allocation proof, complete cloud command coverage, and final exact-revision cloud verification remain open.
