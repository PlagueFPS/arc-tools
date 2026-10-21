# Account integration verification

The five requested changes are integrated on branch `t3/unit4-account-integration` in `/home/angel/.t3/worktrees/arc-tools/t3-5a5c9834`. The base is `7578292`. Local verification passes. Combined real-cloud verification is blocked by recorded HTTP 500 and native RPC failures. The required account alarm has not fired successfully in this integration run. Unit 4 and the migration remain unaccepted pending root's independent reviews and execution.

## Import history

The following commits apply in this order after `7578292`. Every import records its original commit with `cherry-pick -x`.

| Original commit                            | Integration commit                         | Change                                        |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------------- |
| `4988f00b5d3ffe53abff89f6331ff1bb8f82b6dd` | `9eafa00ffe758e61c6948c95f4de071fdff553b2` | Original unit 4 implementation.               |
| `f4e57261807087d231ab4a41a6f981245f709fee` | `d53eb81f5fed74ffaf32e5592e739164062ad416` | Reviewed HTTP and reconstruction harness.     |
| `29c42db35a1eaf9f3701639df6f09184e46fde5b` | `d61e66ffa59fca99c4db41fb3858305f7e1768b9` | Default discovery of eight pure helper tests. |
| `165a0d679f3dda540614e7cf7cbc051aad1a8274` | `212e9cd67b3ff575ccf1be94bc4290c4365763f7` | Failing account and release regressions.      |
| `90231bd5710cd7e76c0ebc82b44011921f6902a4` | `6f1a3dda8c28672da86025132383132e5b9851d4` | Account corrections and native alarm fixture. |

Two additional test-only commits follow the imports.

- `fce87a00213aaf01e7f49b3889faab5abe4b625b` requires the exact abort acknowledgement, HTTP 204, a bounded UUID transition, and strict preparation JSON decoding in the new native case.
- `6e125d8dda167d63642f88455114e3210a322c29` logs failure causes in the native preparation and controlled token HTTP handlers without recovering or retrying them.

The evidence commit containing this document follows those seven commits. Its identity is available with `git log -1 --format=%H -- docs/verification/account-integration.md`. Root should import this entire ordered range with `git rev-list --reverse 7578292..t3/unit4-account-integration`. No duplicate unit 4 base commit from another worker branch is included. Source checkouts `t3-5b69d597`, `t3-d1243984`, `t3-c46f2daa`, and `t3-8c90ffc4` were read only.

## Every conflict and integration edit

The first four imports applied without conflicts. Their stable patch IDs match their originals. The fifth import had exactly one conflict, at `tests/cloud/account-fixture.ts:19`. Both branches added an import after `makeProvider`. The resolution retains both imports. Their current paths after the Twitch package extraction are shown below.

```ts
import { AccountState, policy } from "@arctools/twitch/testing";

import {
  acknowledgeReconstruction,
  identifyFixtureResponse,
} from "./fixture-response.js";
```

All added and removed lines in the fifth imported commit match the original commit, path by path. Its stable patch ID differs because the surrounding harness code differs. The four corrected runtime modules are byte-identical to `90231bd`. No integration change modifies account policy or provider logic.

The automatic merge of `tests/cloud/account-cases.ts` retains the shared bounded HTTP boundary and UUID observer, the complete native alarm case, and the localization assertions. The automatic merge of `tests/cloud/twitch-provider-fixture.ts` retains the fixture response marker and the provider-faithful omission of command, option, and choice localization dictionaries unless `with_localizations=true` is supplied. No localization assertion was removed.

The separate native acknowledgement commit changes only two files. In `account-fixture.ts`, it replaces the new native route's broad `catchCause` with `acknowledgeReconstruction(nativeObject().reconstruct(), "account reconstruction fixture")`. The ordinary reconstruction route keeps the same strict helper. In `account-cases.ts`, it replaces direct preparation JSON parsing with the shared `json` decoder, asserts the reconstruction response is 204, and calls `reconstructedSnapshot` before observing native alarms. All original alarm assertions remain, including exact run counts, a consumed entry alarm, native and intended lease timestamps, no premature validation, lease removal, and exactly one validation after expiry.

The failure logging commit changes only `account-fixture.ts` and `twitch-provider-fixture.ts`. Each affected handler applies `Effect.tapCause` and `Effect.logError` before propagating its original failure. Reconstruction acknowledgement and the alarm/store implementation are unchanged. There is no success fallback or additional request retry.

The complete line-level changes are reviewable with these commands.

```sh
git show 9eafa00 d53eb81 d61e66f 212e9cd 6f1a3dd
git show fce87a0 6e125d8
git diff 90231bd -- tests/cloud/account-cases.ts tests/cloud/account-fixture.ts tests/cloud/twitch-provider-fixture.ts
```

Copies of every import patch, the resolved conflict, the native acknowledgement patch, and the failure logging patch are retained under `.cloud-tests/integration/`. `imports.json`, `import-patch-audit.log`, and `merged-fixture-review.log` record the comparisons. The approved migration plan, root review documents, and `.audit/cloudflare-migration.tsv` remain unchanged.

## Local verification

Checks use Bun 1.3.5, Effect 4.0.4, and Alchemy 2.0.0-beta.83. The frozen install passed with 484 packages and no lockfile change. The final code revision is `6e125d8dda167d63642f88455114e3210a322c29`.

```text
bunx bun@1.3.5 install --frozen-lockfile
Exit 0. Lockfile unchanged.

TURBO_FORCE=true bunx bun@1.3.5 run test
Six workspace test tasks executed with zero cache hits.
192 workspace tests, 701 assertions, 24 files.
Eight helper tests, 73 assertions, two files, outside Turbo caching.
Total 200 pass, 0 fail, 774 assertions across 26 files.

TURBO_FORCE=true bunx bun@1.3.5 run build
Four successful tasks. Zero cache hits.

TURBO_FORCE=true bunx bun@1.3.5 run check-types
Seven successful tasks. Zero cache hits. Root tsc --noEmit passed.

bunx bun@1.3.5 run lint
Biome checked 123 files. No fixes or errors.

git diff --check
Exit 0.
```

The default command executes all 181 original tests, 11 account regressions, and eight harness regressions. Counts come from the actual uncached Bun summaries, including the runtime version printed by every child test process. Final logs are `.cloud-tests/integration/final-default-test.log`, `final-build.log`, `final-check-types.log`, and `final-lint.log`. Earlier local outputs are also retained.

The six review-A corrections remain imported without policy changes. Local tests cover credential lease recovery and consumed-alarm rearming, the validation/401 fence, interrupted subscription binding intent across rotation, complete localization GETs, setup-user 401 invalidation, and atomic authorization allocation for 32 channels plus a distinct sender. Repeated setup and capacity recovery cover the overlapping review-B finding. The 64-attempt bound and ten-minute retention remain unchanged. Revocation retention and optional/required manifest defaults are unchanged.

## Real-cloud attempts and cleanup

The first command was exactly `bunx bun@1.3.5 run scripts/cloud-test.ts account`. It used real Cloudflare providers and `Cloudflare.state()`, a stage containing this worktree's hash and a unique run suffix, and no `dev: true`. The runner filtered live application credentials and supplied only controlled synthetic Twitch and Discord identities. No production, persistent staging, or live-provider mutation occurred.

| Stage                                | Execution                                                                                                                              | Result                                                                                                                                                                                                                  | Cleanup                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `test-account-c0549d51-d74a3fc4f388` | Canonical combined runner at `fce87a0`.                                                                                                | 0 pass, 1 setup failure. First probe snapshot returned HTTP 500 HTML. Account cases were not reached.                                                                                                                   | Exit 0. Zero Workers, zero namespaces, state and output absent. |
| `test-account-c0549d51-f017c4cad438` | Focused probe diagnostic and the exact imported native account test.                                                                   | 1 pass, 1 fail, 6 account cases filtered. Probe succeeded after one recognized pre-route 404. Native preparation returned HTTP 500.                                                                                     | Exit 0. Zero Workers, zero namespaces, state and output absent. |
| `test-account-c0549d51-48c6108f9867` | Diagnostic with newly added failure logging.                                                                                           | 0 pass, 2 fail, 6 filtered. Probe RPC failed. My instrumentation also used unavailable `Effect.tapErrorCause` and introduced a separate TypeError. This stage is invalid as evidence about the original native failure. | Exit 0. Zero Workers, zero namespaces, state and output absent. |
| `test-account-c0549d51-397232086976` | Changed diagnostic after correcting logging to `Effect.tapCause` and passing TypeScript and formatting checks. Same code as `6e125d8`. | 0 pass, 2 fail, 6 filtered. Probe RPC and controlled provider RPC failed. Native preparation stopped before reconstruction or alarm execution.                                                                          | Exit 0. Zero Workers, zero namespaces, state and output absent. |

Every stage has `run.json`, `result.json`, and a copied `console.log` under `.cloud-tests/<stage>/`. The three diagnostic stages also have `resources.json` listing six Workers and six namespaces. The canonical run failed before its resource-journal hook wrote that file. Its deployment console records all six resources, and the independent cleanup checks the exact stage Worker names and associated namespaces through Cloudflare APIs as well as the backend state/output. No missing journal was fabricated. Every `result.json` records `testResult: 1` and `cleanupResult: 0`. There is no passing cloud run from this integration owner.

The separate diagnostic harness is `.cloud-tests/integration/probe-native-diagnostic.test.ts`. It imports `registerAccountTests` directly and selects the exact native test by name. It does not copy or replace that test, manually call credential/alarm RPCs, relax its assertions, or suppress a failed probe result. Both diagnostic tests run even when the first fails. Its launcher is `.cloud-tests/integration/run-diagnostic.ts`, derived from the canonical runner with an explicit diagnostic test path and name filter. Deployment, cloud-backed state, synthetic environment, journal persistence, and final cleanup follow the same lifecycle. These are diagnostic artifacts, not a substitute passing combined suite.

The shared HTTP helper remains byte-identical to the reviewed harness commit. Only the exact missing-Worker 404 fingerprint authorizes bounded retry. In the final diagnostic it classified three such native preparation responses before the reached HTTP 500 stopped the request. No HTTP 500, RPC failure, business failure, JSON/schema failure, or alarm assertion was retried. The full canonical suite was not repeated unchanged until green.

## Concrete cloud blocker and native alarm result

The canonical probe failure had HTTP 500, `text/html; charset=UTF-8`, no fixture marker, 4,785 bytes, and SHA-256 `8ffa3274059fe169af82812b11793d5cff3a937eaf5d3c74bf21c2493db3c232`. Its ray was `a4b1b2aaeddc3acd-DFW`. A scoped telemetry query returned no events for that probe and time window. Its original cause remains unknown.

The later diagnostics establish a more specific reached-fixture failure. In the final stage, probe snapshot returned a fixture-marked JSON 500 containing `RpcCallError` and Cloudflare `internal error; reference = htgsvhb12pe6qtbdq0830bgb`. The earlier instrumented stage retained another probe reference, `bneut8865g7s0be5esqrkgcp`. Both exact responses are saved as `probe-error-response.html` in their stage directories, despite the JSON content.

Final-stage Cloudflare telemetry shows the controlled provider's `/oauth/token` handler failed when its native `request` RPC rejected with `internal error; reference = 2nju2gercivdhg17tjmf7u7v`. The account fixture then rejected `prepareNativeAlarm` with `Native alarm setup failed`. The HTTP layer additionally logged `SchemaError: Expected never`, which hid those original causes until the test-only logging was added. The provider ray was `a4b1be33abee7223` and the native preparation ray was `a4b1be2e6e4a729c-EWR`.

The native test function actually ran in three diagnostic stages. It failed at preparation before it could acknowledge reconstruction, observe a changed UUID, or execute a native credential alarm. Native alarm recovery is therefore **NOT VERIFIED**. No manual RPC success is substituted. Local models prove neither native scheduling nor consumed-alarm behavior on Cloudflare.

These observations do not prove an account-policy defect or identify Cloudflare's internal failure cause. The provider RPC and the unchanged foundation probe both failed at native calls. I did not broaden retry classification, change deployment timing, or change runtime policy to bypass those failures. The retained telemetry files are `.cloud-tests/integration/final-native-account-telemetry.json` and `final-native-provider-telemetry.json`. Earlier queries and outputs are retained separately. Further cloud diagnosis or a fresh independently justified execution remains a root gate.

The failed instrumentation stage and initial Biome formatting failure are retained in `cloud-native-cause-diagnostic.log`, `native-cause-account-telemetry.json`, and `diagnostic-lint.log`. Corrected checks are separate files. No failed result was overwritten or relabeled as a pass.

## Original evidence and ownership

Root's original failed stage `test-account-a0e65c16-56ec6e796e36` remains in its source worktree. Read-only copies of its journals and the original console are under `.cloud-tests/integration/original-evidence/`. The console SHA-256 remains `2f304253bdd91998a11c61dab1b143ee6075da959a34359ae95e93b84e4fb4e2`. The run, resources, and result hashes remain `b820944c3db174a77f7206c883b319f7111bc86c9e2d36902b4146d23cff8246`, `d1fa8061777f12b1acf6f3a12f5f44158f86f3a6dd31bb6e01d92cf26f3dab19`, and `a971e4b00661d3d8b8f848f6c0efd4f3a8113dcb709a95e86ff943524a30576c`.

The same directory preserves the account worker's six-failure capture and its consumed-alarm and capacity-recovery reproductions from `/tmp/arc-account-corrections-before.log`, `/tmp/arc-account-alarm-equality-before.log`, and `/tmp/arc-account-capacity-recovery-before.log`. Source harness diagnostic and passing-stage journals were also copied without modifying them. Historical harness passes verify the earlier harness revision, not the newly integrated native account case. The account correction worker did not run cloud tests. Root's independently reported 192-test, 701-assertion account result agrees with the combined workspace result but is not claimed as this owner's execution.

The local command wrapper refuses to overwrite an existing log. `command-results.tsv` records exit codes. `decisions.tsv` records integration choices and failures. This focused trail is separate from the protected root audit. No delegates were spawned. Root remains the reviewer and orchestrator. Delegated architecture, comment, and trail reviews were omitted under the explicit no-delegation instruction.

Sequence Work into Verifiable Units preserved the failing-regression commit before its fix. Prove It Works required actual uncached test output and API/state cleanup checks, and keeps native alarm recovery unverified. Fix Root Causes led to fixture failure logging and scoped telemetry instead of a retry around the HTTP 500.

## Unit 3 contract and remaining gates

Unit 3 consumes `TwitchAccount` from `twitch-contracts.ts` and `bindAccount` from `twitch.ts`. Dispatch retains the same stable attempt, complete input, and original absolute deadline across retries. It waits until `retryAt`, stops on ambiguity or other terminal outcomes, and does not start sends at or after the deadline. No exported dispatch signature changed in the correction wave.

The account storage schema now includes `subscriptionIntents`. Session generations identify the credential across validation and explicit 401 invalidation. These are private account details. Unit 3 must send verified subscription observations with the actual subscription, sender, broadcaster, and status. A challenge alone does not prove enabled delivery. Signed ingress owns signature, application, channel, replay, and revocation validation.

`accountRuntimeConfig.webhookReady` remains deliberately `false`. Unit 3 may change that composition decision only when signed challenge, notification, and revocation handling exists. Live setup remains `ingress-required` until then. OAuth state capacity is now 33, covering a distinct sender and 32 channels. Repeated setup can replace obsolete links at capacity, so operators use the latest returned links. Unknown remote subscription bindings are replaced; interrupted creations are adopted only with matching durable ownership or intent.

The following gates remain NOT VERIFIED for the combined revision.

- A passing canonical real-cloud suite, including all foundation/cache/account/release cases and the new native credential alarm case.
- Actual lease-alarm recovery, consumed-alarm rearming, and post-expiry validation on real Cloudflare after successful native reconstruction.
- Native reconstruction across repeated interrupted signing-secret rotations.
- Root's independent technical/comment review and real-cloud execution of the final combined revision.
- Live personal-account grant survival after onboarding-token expiry, signed EventSub challenge/notification/revocation delivery, and real Twitch chat timing.
- Discord direct public success, ephemeral failure, cold-path timing, live nonproduction registration, and propagation behavior.
- CI execution, environment credentials, developer-portal configuration, actual launch counters, free-tier usage, and cost.
- Unit 3 tenants and signed ingress, plus unit 5 final composition and legacy deletion.

No tenant implementation or legacy deletion is included here. The quiet-launch capacity assessment still includes the retained 64-attempt/ten-minute bound. That bound is not newly treated as a blocker.
