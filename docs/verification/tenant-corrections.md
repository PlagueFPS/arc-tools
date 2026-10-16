# Tenant correction evidence

This worktree imports the candidate exactly once, in order. `6731049` maps to `b2475ea`, `55e012b` to `613b72f`, `3a4ac15` to `2403d3e`, and `0c5caa6` to `e2e270a`. The base is root `b243f09`. The source checkout and root-owned design and review documents remain unchanged. Root reviews and integrates after acceptance.

## Reproduction before application edits

With the pinned Bun 1.3.5 directory first in `PATH`, `bun test apps/bot/test/tenant-corrections.test.ts apps/bot/test/ingress.test.ts` reports `15 pass`, `10 fail`, and `100 expect() calls`. The retained log is `.cloud-tests/corrections-before.log`.

Three failures reproduce eight abandoned Discord claims blocking fresh admission on a new activation at time zero and on the same activation at 5,000 and 602,999 milliseconds. Two reproduce safe retries requested at 100 or 200 milliseconds and returned at 200 being expired despite the original 10,000-millisecond cutoff. Two reproduce command defects escaping without a terminal response. Two signed HttpApi regressions reproduce private failure when the Tenant clock trails the Worker stamp by 1 or 20 milliseconds. The expired signed control passes.

The tenth failure holds an actual HTTP response through `makeProvider` and the accepted `makeAccount` ledger. Advancing the controlled policy clock by 1,500 milliseconds and recovering produces a second dispatch of the same live attempt. The provider POST is still owned by the first account invocation. This is not a toy dispatch-only reproduction. The live-capacity, deadline-equality, and eight-due-item controls pass before corrections. Eight due items progress through two bounded batches and remove the alarm, so the scheduler is retained.

These are newly reproduced local defects. Exact attribution of historical cloud private failures remains INCONCLUSIVE. The clock reproduction does not establish their cause.

## Correction design

The durable tagged work state remains authoritative. Admission reconciles interrupted or expired Discord computations before capacity checks, retaining replay identity and retention. A trusted receipt may lead the Tenant clock without changing its original stamp or deadline. Safe elapsed retries schedule due-now only while both the requested time and completion remain strictly before cutoff.

For delivery, an activation-local completion signal joins a known live dispatch rather than redispatching it when its durable recovery probe becomes due. The signal lives only for that claimed operation, clears on all exits, and is bounded by the original work deadline. Unknown completion and new activations still recover the exact frozen attempt through the account ledger. The one-second probe remains useful for a crash or lost completion. No arbitrary enlarged delivery lease or account-policy rewrite is proposed. This adds ephemeral ownership to the selected design and must receive root review.

Command defects are handled only around command execution. Cancellation and storage/infrastructure failures must remain observable. No whole-operation defect catch is proposed. Test-only request observation will wrap the actual namespace lookup and RPC boundary and forward to the real Tenant. Namespace API listing is removed as an allocation oracle.

## Gates

Local corrections, full uncached gates, disposable cloud proof, cleanup, and root independent reviews are pending. Up to two new disposable cloud runs are authorized after local gates. Live-provider timing, privacy, token expiry, operating cost, and final migration acceptance remain separate gates.
