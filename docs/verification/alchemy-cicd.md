# Alchemy CI/CD verification

## Implemented behavior

This adapts [Alchemy Cloudflare tutorial part 5](https://alchemy.run/cloudflare/tutorial/part-5/) to the existing working bot applications. `release.yml` owns staging and production deployment plus Discord global registration. CI calls it only after successful `main` checks, passing the exact checked push SHA. Manual dispatch uses the same job and application-ID lock. PR origins, wrong application identities, stale automatic commits, abbreviated revisions, and missing public origins fail before deployment. The registration command retains its exact health revision fence and partial-release summary.

The repository variable `PROD_DISCORD_APPLICATION_ID` supplies the automatic concurrency input. The `prod` environment's `DISCORD_APPLICATION_ID` must match. The job selects the `prod` or `staging` environment before resolving its variables and secrets. It does not use an environment-scoped variable to construct its concurrency group.

CI retains build, types, lint, local tests, and the random canonical `test:cloud` tenant suite. That suite still always attempts strict destruction. Recovery retries and JSON artifacts remain unconditional after a stage is allocated. Trusted runs fail with the names `CLOUDFLARE_TEST_ACCOUNT_ID` and `CLOUDFLARE_TEST_API_TOKEN` when configuration is absent. Fork PRs explicitly skip cloud acceptance and previews while retaining local checks. No workflow uses `pull_request_target`.

Resident previews use the existing seven-worker tenant stack. A SHA-256 of repository and PR number supplies disjoint eight- and twelve-character slices for `test-tenant-<8hex>-<12hex>`. The revision and checkout path do not affect identity. The preview controller reads current PR state after acquiring the workflow lock, after the first deploy, and after explicit-origin redeployment and health. Closure routes to strict cleanup. A new PR head or changed merge SHA prevents URL publication. Deploy and close cleanup share one repository and PR concurrency group with cancellation disabled.

Both synthetic paths share `syntheticEnvironment`. It removes inherited `TWITCH_*`, `DISCORD_*`, `ARC_*`, and `OPERATOR_*` values before adding fixtures. Preview deployment supplies the checked merge SHA explicitly and drops GitHub credentials from cloud children. It records that SHA separately from the PR head SHA. No preview registers commands, requests grants, or uses production bot credentials.

The preview obtains its first URL from resolved Alchemy output. It redeploys with that exact origin, verifies health, and updates the bot-owned marked PR comment. It runs cloud children from the recovery directory so pinned Alchemy's optional root `.env` fallback does not reload bot configuration. No application runtime or stack code changes are required.

Close cleanup uses trusted `main` code and derives the stage from PR identity. It writes a valid `CloudSettings` journal before mutation, even on a fresh runner. Existing `cloud-cleanup.ts` calls strict `Core.destroy`, checks absent stage state and output, lists Workers and namespaces, and verifies zero owned resources. Missing output uses its existing exact-name fallback. The shared account state backend remains. The resident lifecycle never runs `foundation.test.ts`, whose teardown would destroy the preview.

## Local evidence

Verification uses Bun 1.3.5 with `--no-env-file`. Alchemy 2.0.0-beta.83 and Effect 4.0.4 remain pinned. Installed `alchemy/src/Test/Core.ts` confirms the `Core.run`, `Core.deploy(options, Stack)`, and `Core.withProviders` signatures used by the adapter. The existing cleanup retains `Core.destroy(options, Stack)`.

Run the deterministic focused suite:

```bash
bun --no-env-file test scripts/preview.test.ts scripts/preview-workflows.test.ts
```

The suite covers identity stability and separation, rejected cleanup targets, full SHA parsing, origin validation, fixture environment stripping, fork rejection, late queued deployment after closure, closure during either deployment, stale head and merge observations, repeated cleanup, and failed cleanup or health. CLI tests run the actual controller with fake cloud executables and an intercepted GitHub transport. They verify a journal exists before each child, both origin passes, checked revision injection, comment updates, recovery without a prior artifact, and retained failure records. No test calls GitHub or Cloudflare.

Workflow tests parse YAML with Bun's parser, evaluate actual event conditions across push, trusted PR, and fork PR cases, verify required dependency edges, compare expanded deploy and cleanup lock groups, and execute the actual release guard against fake contexts and API replies. Actionlint validates workflow syntax and expression contexts separately. These checks do not establish remote permissions or successful hosted execution.

The implementation worker ran these root checks successfully:

```bash
TURBO_FORCE=true bun --no-env-file run build
TURBO_FORCE=true bun --no-env-file run check-types
bun --no-env-file run lint
TURBO_FORCE=true bun --no-env-file run test
```

Build completed four tasks. Type checking completed five workspace tasks plus the root TypeScript check. Those workspace checks bypassed the Turbo cache. Lint checked 134 files. All 317 workspace tests and 60 root helper tests passed. The focused preview and workflow suite passed 24 cases with 252 assertions. Actionlint 1.7.7 passed all three workflow files. Root independently reviews and reruns the combined changes before acceptance.

## Unverified activation and rollout limits

Remote activation is UNVERIFIED. This implementation runs no deployment, provider call, GitHub mutation, token creation, workflow, comment, or real bot operation. API permissions, account quotas, first synthetic cloud deployment, namespace cleanup under the CI credential, and hosted comment permissions need operator validation.

Use [the bootstrap guide](../ci-cd-bootstrap.md) to provision the resource contract. Populate the existing prod bot variables and secrets privately. Manual staging retains its existing operator setup. Keep production's exact working `ARC_PUBLIC_URL`, portal callbacks, and grants. The first production runtime failed without that URL until it was configured and redeployed. This record makes no blank-origin runtime claim.

Initial close cleanup fails explicitly if `main` lacks the new controller. It does not claim cleanup success. Recover from a checkout containing the reviewed implementation, or land the implementation and dispatch **Remove synthetic preview** with the closed PR number. Follow [the operator recovery procedure](../operator-guide.md#recover-a-resident-synthetic-pr-preview). Branch deletion does not prevent recovery, and downloaded artifacts are never executable inputs.

GitHub concurrency does not guarantee queue ordering or delivery of every trigger. Current PR reads prevent a late queued deployment from recreating a closed preview. A stale job can leave an unpublished partial update until a newer checked run reconciles it. PR reads and comment updates are separate API operations, so the system cannot make a change of PR state atomic with publication. Missed or failed cleanup needs explicit retry. There is no scheduler. Resident fixture state may survive pushes and reopening, and it consumes Cloudflare resources until cleanup succeeds.
