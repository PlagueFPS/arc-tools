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
