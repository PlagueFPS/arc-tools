# Cloud CI failure investigation

The cloud failures have several causes. The latest run failed in fixture startup, earlier assertions depended on competing deadlines or a temporary state, and one earlier cold command exceeded the application's useful-response contract. Treating all of these as one flaky test would hide an unresolved application reliability issue.

This investigation inspected the CI runs from October 18 through October 20, 2026, their available recovery artifacts, the current harness, and the prior correction in PR #14. No production behavior or test acceptance criteria changed.

## Latest failure: fixture startup, exact cause unavailable

[Run 39454194871](https://github.com/PlagueFPS/arc-tools/actions/runs/39454194871) checked the verification-skill PR. Alchemy reported all seven Workers deployed. The next request, `GET /snapshot` on the foundation probe, returned HTTP 500 with `content-type: application/json` and `x-arc-cloud-fixture: v1`. The request's Cloudflare Ray ID was `a4d944f9dfa4ff19-PDX`.

The shared `beforeAll` hook in `tests/cloud/foundation.test.ts` failed before any test case ran. This was a failure of the test fixture's Durable Object request path. It was not a command assertion, Discord interaction, Twitch dispatch, build error, or credential rejection. The verification skill added in that PR is not invoked by this CI step.

The response body had 290 bytes and SHA-256 `6770fb14531f9098e9e22f44612a3a1bfc39c42aa3d66a551aad52b2c945ac0f`. Its explanation is unavailable in retained evidence. `tests/cloud/probe.ts` turns snapshot exceptions into JSON containing `probeError: Cause.pretty(cause)`. `tests/cloud/fixture-http.ts` reads that body but retains only its hash and length before throwing `FixtureHttpError`.

The recovery artifact contains `run.json` and `result.json`, with `testResult: 1` and `cleanupResult: 0`. No `resources.json` exists because the hook failed before the resource census. The runner and CI cleanup verified removal of the stage's resources and control-store state.

Deployment propagation or a transient Durable Object infrastructure error is plausible, but the evidence cannot distinguish those from a fixture or framework defect. Cloudflare documents eventually consistent releases in the [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). That documentation does not identify this specific failure.

## Earlier failures are distinct

### Competing slow-source deadlines: corrected

[Run 39268492281](https://github.com/PlagueFPS/arc-tools/actions/runs/39268492281) and [run 39276368680](https://github.com/PlagueFPS/arc-tools/actions/runs/39276368680) expected the source-data error for a deliberately slow response. They received the private tenant-timeout response instead. A later timing-coverage assertion rejected the same observation, making one outcome appear as two test failures.

The source timeout begins when fetching starts. The tenant computation cutoff begins at ingress. Network transit and cold initialization consume part of that tenant budget before the source request starts, so either timeout can win. [PR #14](https://github.com/PlagueFPS/arc-tools/pull/14) corrected the slow scenario to accept the two exact committed response/decision pairs. It retained strict checks for privacy, disabled mentions, no deferral, no Worker fallback, and missing/malformed-data behavior. This is a confirmed test-contract problem with an existing correction, not the cause of the latest failure.

### Cold useful-response failure: unresolved application acceptance failure

Run 39276368680 also failed the first useful cold command. Its signed Bot request returned HTTP 200 with a private timeout instead of the expected Sensors sale value. The diagnostic headers recorded `phase: committed`, `code: timeout`, and an admission delta of 725 ms. This was a tenant decision, not a Worker fallback.

The test deliberately requires the first cold command to return a useful answer within the original budget. Calling this a harmless flake, warming that tenant before measuring it, or accepting a timeout would weaken that requirement. PR #14 explicitly left this failure unresolved after it did not recur in its fresh cloud runs. The retained evidence does not isolate which downstream cold operation exhausted the remaining budget.

### Native interruption: a fragile observation window

[Run 39273023145](https://github.com/PlagueFPS/arc-tools/actions/runs/39273023145) failed to observe `works.interrupt.kind === "computing"`. The final snapshot had no work under that key. The successful POST was not established before the assertion failed.

The current test starts a request in a child fiber, injects a 1,500 ms source delay, and polls snapshots over real HTTPS for the temporary `computing` state. It makes up to 21 observations, with 25 ms spacing plus each request's network time. Increasing the poll count alone cannot ensure an intermediate state is observed before computation finishes or the original deadline expires. In this failed run the snapshot responses were empty of tenant work, so the logs do not prove whether admission was delayed, failed, or never completed. Logging added afterward helps distinguish those outcomes but does not synchronize the test.

`tests/cloud/metaforge.ts` already supports holding and releasing source responses. A correction should use that existing external-provider boundary to arrange the interruption, observe source arrival and admitted work, then reconstruct before the original cutoff. It must surface an early failure of the original request immediately and retain the original deadline. Extending the deadline or treating a missing admission as success would invalidate the recovery proof.

### Alarm observation deadline: insufficient evidence to classify

The same run exhausted 31 snapshots separated by one second while waiting for the native retry alarm, then failed `completed === true`. Its test case took about 32 seconds. The implementation deliberately throws on the first alarm and expects the second invocation to complete with retry count one.

[Cloudflare's alarm contract](https://developers.cloudflare.com/durable-objects/api/alarms/) specifies automatic retries with exponential backoff. It does not establish the suite's 30-second observation window as a guaranteed upper bound. The failed run predates the detailed armed/reconstructed/final-state log added later. It therefore cannot establish whether the initial invocation was delayed, the retry was delayed, or the alarm path malfunctioned.

Use a named observation budget with persisted invocation timestamps and the final state on exhaustion. Preserve exact native retry and completion assertions. A longer wait needs a stated acceptance reason; a rerun passing does not explain the original failure.

### Other failures were not cloud flakiness

[Run 39171270283](https://github.com/PlagueFPS/arc-tools/actions/runs/39171270283) lacked `CLOUDFLARE_ACCOUNT_ID`. [Run 39270724404](https://github.com/PlagueFPS/arc-tools/actions/runs/39270724404) failed during the package build before cloud testing. These should remain separate from integration reliability.

## Harness changes to prioritize

1. Preserve safe, structured fixture failure details before teardown. Include the test phase, route, Ray ID, nested RPC error classification, and platform retryability/overload flags. Keep arbitrary provider bodies and credentials out of public logs. Name setup failures so an unnamed `beforeAll` error does not hide the failing operation.
2. Synchronize the interruption scenario at the existing held-provider boundary. Fail immediately if the original request fails before admission. Keep the original deadline and all native reconstruction assertions.
3. Record native alarm invocation times and a complete exhaustion snapshot. Define the observation budget separately from Discord's user-response deadline.
4. Trace cold Worker-to-Tenant-to-cache-to-source work. Keep the useful cold-response gate strict and investigate the first stage that consumes the budget.

The HTTP helper currently retries only a recognized Cloudflare 404 placeholder on disposable test hosts. It intentionally stops on fixture 500s and transport failures. Do not add blanket retries to make these failures disappear. Cloudflare recommends retrying idempotent operations when the exception is marked retryable, avoiding overload retries, and recreating a failed stub in its [error-handling guidance](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/). Any readiness retry should use those facts and remain separate from measured business requests.

## Reproduction and retained evidence

One fresh run of the canonical cloud runner used stage `test-tenant-cdce75d1-aad2ec2c1156` at checkout `6e62ec877fd26b678eefe0ac58ad752f94dc923a`. A temporary Bun preload wrapped client fetches only to retain error responses from synthetic probe and tenant hosts in a private local file. It did not add retries, alter fixture responses, change deadlines, or modify deployed code. The wrapper was supplied through `BUN_OPTIONS=--preload=/tmp/arc-cloud-investigation/capture.ts` while running `bun --no-env-file run scripts/cloud-test.ts`.

The fresh run passed all 29 tests. Both the test runner and cleanup exited zero. Independent cleanup verified zero matching Workers, zero Durable Object namespaces, absent stage state, and absent output, while retaining the shared control backend. The original CI 500 did not recur. A passing fresh run cannot establish that the original failure was transient or that the suite is reliable.

Downloaded failed-job logs and recovery artifacts are retained under `.cloud-tests/cloud-ci-investigation-20261020/`. The reproduction's own journals and timing observations remain under `.cloud-tests/test-tenant-cdce75d1-aad2ec2c1156/`. These ignored local artifacts are not part of the committed report. Re-fetch a failed job with `gh run view RUN_ID --repo PlagueFPS/arc-tools --log-failed` and its recovery artifact with `gh run download RUN_ID --repo PlagueFPS/arc-tools --pattern 'cloud-test-recovery-*'`.

## Test corrections after investigation

The follow-up changes affect cloud tests and CI evidence retention. Application code and the useful cold-response requirement remain unchanged.

- The interruption scenario holds the synthetic Metaforge response until teardown instead of sleeping for 1,500 ms. It requires both persisted computing state and an observed source request before reconstruction. An already-completed original request fails immediately, and a scoped finalizer releases the held provider even when an assertion fails. The original response deadline is preserved.
- The HTTP helper retains a bounded `probeError` only for marked HTTP 500 responses from `GET /snapshot` on disposable probe Workers. It still stops without retrying. Other response bodies and unrelated JSON fields stay excluded. The new regression failed before the correction because the error explanation was absent, then passed with the correction.
- The native alarm probe persists invocation timestamps, attempt numbers, and retry counts. The observer uses a 60-second wall-clock budget instead of a fixed count of polls. This is a bounded integration observation policy, not a Cloudflare latency guarantee or a change to Discord's deadline. Completion, exact retry count, and removal of the alarm remain required. CI retains `alarm-observation.json`, including the last observed state on exhaustion.
- The startup/resource-census hook has a named Effect trace so setup failures identify the phase.

The previously corrected slow-response expectation from PR #14 remains in place. No blanket retries, warming of the measured cold tenant, accepted cold-command timeouts, or production changes were added.

The corrected suite passed all 29 cases in stage `test-tenant-cdce75d1-1c3209362d85`, including held-source interruption, exact native alarm retry, and the first useful cold command. Test and cleanup exit codes were zero. Independent teardown verified zero stage Workers and Durable Object namespaces, absent state/output, and retention of the shared control backend. Evidence remains in `.cloud-tests/test-tenant-cdce75d1-1c3209362d85/`; the full terminal transcript is `.cloud-tests/cloud-ci-investigation-20261020/fixes-cloud.log`.

The required local checks passed in order: `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run test`. A fresh hosted CI run is the next evaluation; the local pass does not resolve the historical fixture 500 or establish a sustained reliability rate.
