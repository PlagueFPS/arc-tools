# Completed account alarm recovery evidence

This correction changes the cloud test oracle. It does not identify the historical cause or accept the migration. Stage `test-tenant-8c6e6c0f-18de621764a7` remains failed with 28 passing cases, one failure, and 631 assertions. Its extra global validation remains unattributed.

## Baseline and scope

The isolated parent was `87d0e16`. Exactly `9d5b7d6`, `ab7e9e1`, `20022e3`, `448f1a2`, and `4faeea0` imported as `0c82e5c`, `229a236`, `a6cc5da`, `4457fbc`, and `dabdddb`. Before editing, application, package, script, workflow, stack, configuration, manifest, lockfile, and pin contents matched `a97ae06`. The frozen Bun 1.3.5 installation passed. Parent audit and root review documents remain unchanged.

The correction changes `tests/cloud`, this dedicated evidence document, and the existing root helper test command. It adds the alarm proof to the default suite. Production account, storage adapter, HTTP provider, application routes, policy, clocks, deadlines, leases, rate limits, retries, sleeps, provider responses, infrastructure, and dependency versions remain unchanged. No production telemetry, fetch patch, header injection, or detached fiber is added.

## Types and ownership

`alarm-attribution.ts` owns the schema-validated journals and fixture capture functions.

- `ValidationCorrelation` contains the invocation UUID, activation UUID, operation, and optional durable alarm ordinal.
- `CompletedAlarmRun` contains `key`, activation UUID, durable alarm ordinal, account clock value, completion wall time, entry alarm, lease, intended and native schedules, safe credential fingerprint and expiry/validation times, and invocation UUIDs.
- `AccountAttribution` retains activation events, invocations, immutable completed runs, and safe diagnostic integrity errors. Every collection is bounded at 128 and has a dropped total.
- `ProviderAttribution` retains global and credential counts, plus bounded actual HTTP events carrying the parsed correlation. Its event/count append uses the same transaction as the existing global counter increment.
- `recordCompletedAlarm(storage, run)` reads the production account row, native schedule, and invocation journal and appends the safe completed record and completion event in one fixture storage transaction. An existing key cannot be overwritten.
- `observeValidations(providerFor, storage, instance)` builds the unchanged stateless production provider for each invocation using its existing endpoint options. Only `validate` uses the correlation prefix. Setup, OAuth, RPC, construction, credential, and native alarm validation all use that wrapper.

`account-fixture.ts` calls the real production account alarm before recording its completion. The existing snapshot returns the live activation and durable journal. The other-account attribution endpoint now also returns the live activation with its journal. A GET can activate the object and construction can schedule work. Matching an activation to a payload does not establish which request caused that activation.

`twitch-provider-fixture.ts` accepts `/fixture-validation/<activation>/<operation>/<ordinal-or-none>/<invocation>/oauth/validate`. It parses correlation at the fixture boundary and normalizes the path to the existing `/oauth/validate` handler. Actual validation still uses normal production HTTP and fetch. Provider status and response bodies remain unchanged. Malformed correlation is retained as an integrity failure. Raw credentials, authorization headers, bodies, and exception contents never enter the attribution journals.

`completed-recovery.ts` owns pure selection and verification.

```ts
stableRunKey(run): string
completedRunKey(account, alarmRun): string
selectCompletedRun(account, runKey): CompletedAlarmRun
verifyCompletedRecovery(evidence: CompletedRecoveryEvidence): {
  earlyRunKey: string;
  runKey: string;
  invocationId: string;
  httpEventId: string;
}
verifyCompletedValidation(evidence: CompletedRunEvidence): {
  runKey: string;
  invocationId: string;
  httpEventId: string;
}
```

A run key combines the activation UUID and durable alarm ordinal. The canonical test selects the uniquely completed ordinals 1 and 2 once, then retains their keys. Later activations and ordinals cannot replace those records. The verifier returns the successful invocation and HTTP event IDs or throws a safe reason. It requires zero dropped totals, no integrity errors, unique IDs, complete lifecycle records, and exactly the recorded invocations for each selected run. It checks the reconstructed activation, early lease and native schedule, cleared recovery lease, and the production hourly-or-expiry schedule from those completed records.

Early run 1 must have exactly zero invocations and zero actual HTTP events scoped to its run. Recovery run 2 must have exactly one completed successful invocation and exactly one actual HTTP event. The UUID, activation, ordinal, operation, and credential fingerprint must match directly. A second HTTP event under the same invocation UUID fails. So do two invocations, missing or unresolved records, wrong UUID/fingerprint/scope, orphan requests, ambiguous selection, and truncation. Uncorrelated HTTP using the completed credential is ambiguous and fails. Fingerprints never supply a positive invocation-to-request join.

The selected design rejects both global counter deltas and per-credential deltas as acceptance oracles. Other actors can change global counts. Later activations can legitimately validate the same credential. Ordered fingerprint/count pairing cannot establish causality between same-credential requests without runtime ordering assumptions. Direct UUID correlation and immutable completed runs avoid those assumptions. Global and fingerprint counts remain diagnostic.

## Provider exit preservation

Only the provider wrapper makes diagnostic journal writes best effort. Start/completion storage defects cannot skip the actual provider call or replace its success, typed failure, defect, or interruption. The wrapper attempts a bounded safe integrity record and preserves the provider exit in the same fiber. Missing/incomplete evidence still fails verification if even the integrity write is unavailable.

Completion capture, activation capture, and runner JSONL append failures remain visible. The canonical runner creates the artifact directory. Inability to retain required evidence fails the test. This is not a claim of unconditional exit preservation outside the provider wrapper.

## Maintained local proof

Use the pinned executable first in PATH.

```sh
export PATH=/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin:$PATH
bun install --frozen-lockfile
bun test ./tests/cloud/alarm-attribution.test.ts
TURBO_FORCE=true bun run test
TURBO_FORCE=true bun run check-types
TURBO_FORCE=true bun run build
bun run lint
```

The focused proof runs the real production account and storage adapter, production HTTP provider, and actual provider fixture through loopback HTTP. Explicit local clocks and manually invoked local alarms provide reproducible competing sequences. They do not establish a historical Cloudflare cause.

The positive proof captures early zero and recovery one, validates another account, then explicitly reconstructs the target and invokes its next local alarm. Global validations become 1, 1, 2, 4, and 5 across setup, early, recovery, other-account setup/reconstruction, and later target reconstruction. The original recovery returns identical successful IDs against the latest journals. An attempt to overwrite its completed key fails without changing the journal.

The central negative proof performs two actual production HTTP validations through the same invocation-specific provider under one wrapper invocation. It observes one invocation UUID, two actual HTTP events, and rejection by the verifier. Separate proofs exercise two actual invocations in recovery, actual early-run validation, and early-run HTTP with no invocation record. Boundary and mutation proofs reject malformed, missing, wrong, truncated, ambiguous, and incomplete evidence.

Eight proofs inject start or completion storage failures for provider success, typed failure, defect, and actual fiber interruption. Every provider still reaches actual loopback HTTP. Two further proofs make both the diagnostic and integrity writes unavailable and confirm rejection of missing or incomplete records. Serialized evidence contains neither synthetic raw tokens nor canary secrets. Bounded journal proofs exercise completed-run, invocation, activation, HTTP-event, and credential-map eviction with dropped totals.

The focused suite passes 18 tests and 139 assertions. The uncached default command now includes that file and passes 313 tests and 1,633 assertions. Its workspace portion passes 287 tests and 1,421 assertions; the root helper invocation passes 26 tests and 212 assertions across three files. Uncached typechecking passes five workspace tasks plus root TypeScript. Build passes four tasks. Biome checks 127 files. Frozen installation, `git diff --check`, production-path comparison against `a97ae06`, and parent audit/root-review preservation checks pass.

Logs are `/tmp/arc-completed-{install,proof,tests,types,build,lint}.log`. The first lint invocation found one formatting difference. A formatting correction and the subsequent full lint invocation passed. No lint suppression or comment was added.

## Canonical cloud contract

The original early poll remains bounded at 30 repeats spaced 100 ms. Recovery remains bounded at 120 repeats spaced 100 ms. The case timeout remains 90 seconds. No business retry is added.

After verifying the completed recovery, the same case explicitly reconstructs only the target using the existing endpoint. Normal production construction schedules the next alarm. Only Cloudflare native delivery invokes that cloud alarm. The additional native proof has its own 120-repeat, 100-ms bound, matching the original recovery readiness bound. It waits for a completed invocation on a new activation beyond the pre-reconstruction live ordinal and chooses the earliest such durable ordinal. Selection does not depend on which snapshot is latest, and later completed runs remain separate. The selected invocation must pass the same exact actual HTTP verification. An ambiguous ordinal or duplicate invocation fails.

The test then verifies the original recovery again against the latest account and HTTP journals. It requires identical successful IDs while demonstrating that global validations exceed the old baseline-plus-one expectation. No manual cloud alarm, extra clock advance, provider duplicate injection, delay, or whole-case retry is used.

The two removed global acceptance assertions were `early global === baseline global` and `late global === baseline global + 1`. Their replacements are exact zero early invocations/HTTP and exactly one successful recovery invocation/HTTP joined by UUID, fingerprint, and run key. Assertions that formerly read the latest mutable observation now read the selected completed record. Global totals remain in the retained diagnostics and paired demonstration.

One disposable canonical tenant run is authorized after the local proof and source commit. Independent cleanup must verify zero Workers, zero namespaces, absent stage state/output, and retained control infrastructure. No second run is authorized if this run fails. The result and artifact hashes will be appended after that execution.


## Single canonical cloud result

Source commit `387fe9b6a77996e58c0de5fb699cd653768650b3` ran exactly once using `bun run scripts/cloud-test.ts tenant`, `Cloudflare.state()`, and no `dev` flag. Stage `test-tenant-f334a8f9-724279c3748a` passed all 29 cases and 637 assertions. `result.json` records `testResult: 0` and `cleanupResult: 0`. There was no second deployment or whole-case retry.

Prepared, early, recovery, paired-native, and final provider snapshots show global validations `19, 19, 20, 21, 21`. The same target credential fingerprint counts are `1, 1, 2, 3, 3`. The native proof completed these selected runs.

- Early run `2ee737a6-5b9d-4b07-be87-39fd0628f5eb:1` has zero invocations and zero actual HTTP events. Its entry alarm is null. Its retained lease, intended schedule, and native schedule all end at `1792280273345`.
- Recovery run `2ee737a6-5b9d-4b07-be87-39fd0628f5eb:2` has one successful invocation `37bf8a2a-7a6e-4b7a-ba10-103a8a632d71` and exactly one matching actual HTTP event `278e590c-2c35-43d0-9920-5241cf48045c`. Its lease is cleared and intended/native schedule is `1792283868403`.
- After explicit target reconstruction, Cloudflare native run `c7a9bd88-a6fb-4852-943d-ab5b95e78a99:3` has one successful invocation `e61909a6-6e0c-46e4-9d27-1d7a84dda31d` and one matching actual HTTP event `1e911e97-246b-457d-9c1b-d55b16f7edf4`. Its entry alarm is null, lease is cleared, and intended/native schedule is `1792283869046`.

All three runs retain fingerprint `ad538f02501212d49e8aa2e74d026432c47102bbffbff81638eeff71eb82ab30`. The run-2 and run-3 schedules match the production hourly-or-expiry calculation from their completed credential observations. Direct UUID and run scope establish the request join. The shared fingerprint alone does not.

The canonical case reverified run 2 against journals after run 3 and returned identical run, invocation, and HTTP event IDs despite global count 21 exceeding the old expected 20. A separate offline replay decoded the final retained account/provider schemas and called the same pure verifiers. It returned those identical original IDs and the distinct run-3 IDs. `/tmp/arc-completed-review.ts` and `/tmp/arc-completed-cloud-review.json` retain that replay and its safe output. They can be rerun with pinned Bun after cleanup without deploying anything.

Final target and provider dropped totals are all zero. The target integrity-error list is empty. A scan of the retained attribution JSONL found no canary secret, raw synthetic app token, access/refresh-token field, or authorization-header field. These observations demonstrate a legitimate later native validation on this execution. They do not identify the cause of the historical failed execution. Added observation can affect scheduling.

Normal suite destruction removed all seven Workers and ten namespaces. The independent cleanup process then emitted the following confirmation.

```text
CLEANUP VERIFIED test-tenant-f334a8f9-724279c3748a: Cloudflare lists 0 Workers and 0 DO namespaces; state entries and output absent; control backend retained
```

All six stage artifacts remain under `.cloud-tests/test-tenant-f334a8f9-724279c3748a/`. The full console remains `/tmp/arc-completed-cloud.log`. Single-run timing artifacts are retained without a performance, cost, or live-provider claim. No production or persistent staging deployment, real Twitch or Discord mutation, root integration, or final migration acceptance occurred.

SHA-256 hashes follow. The same list is retained in `/tmp/arc-completed-artifact-sha256.txt`.

```text
299cd3a1da658eeef69d99b1d765f11b4f9d1bccd944605e14fc89a6612bdd4f  .cloud-tests/test-tenant-f334a8f9-724279c3748a/run.json
0b339ebfe2a07ceeca9d420dd791b2e95202e52711f7f18b5d3cb64f77257d8c  .cloud-tests/test-tenant-f334a8f9-724279c3748a/result.json
d207f9ad744a3f1fde59a05e9c270eec272efb720ab3f9841fa42ada6fe889d7  .cloud-tests/test-tenant-f334a8f9-724279c3748a/resources.json
5e45919a735eb28037acd83decb3624d6723416137ef8cb508d7939bcb19c838  .cloud-tests/test-tenant-f334a8f9-724279c3748a/native-alarm-attribution.jsonl
410351c3da1ce9a39f5bb690d39dcee80e831059fcf2e5cf424c4556c51c841b  .cloud-tests/test-tenant-f334a8f9-724279c3748a/timings.json
118a2bd1504e80a6e92b0654667062fcd6e6cca11e9897bb536af4c5664582a4  .cloud-tests/test-tenant-f334a8f9-724279c3748a/twitch-timings.json
0bd49ae6e44a3d30e7071313027bfa62ac60ab38f4f4ea4500a16c9d02fd9468  /tmp/arc-completed-cloud.log
8041ccc321eca91a305dff15f815444d3b8beaf05f231fab2005f42858de369d  /tmp/arc-completed-review.ts
0f750840437ee6f07b6a073448dadb2c0ed64a1cc19752ce5967047301415002  /tmp/arc-completed-cloud-review.json
927fe0b71a18a6316de96788965a5b9f0112b9618f5332cd3cac7d7a86b54c14  /tmp/arc-completed-install.log
6b7d60c712922da82dc0a6d5214ae570983ab268dcf26bedfafe7d9348727071  /tmp/arc-completed-proof.log
08d767f39531b5d2c2263aac20d53617321116cc9f9185844ca7aca0652f4110  /tmp/arc-completed-tests.log
b52dc0ae42a0154ce9d8df511086ca0b287da609837e68cd3b0efe5d74be57eb  /tmp/arc-completed-types.log
3bb6708d0c8da7b9db4b8bf3322046b294780a6e52c024f32841aca509d9a5bb  /tmp/arc-completed-build.log
424f9759ee533561c775b5eb696722c6fdd377d5add0be919e1c942c1a00d30b  /tmp/arc-completed-lint.log
```
