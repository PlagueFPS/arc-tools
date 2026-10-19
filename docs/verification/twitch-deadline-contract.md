# Twitch deadline contract correction

Local reproduction, correction, and verification are VERIFIED. Unit 3 remains NOT ACCEPTED pending root's fresh independent reviews and exact-revision canonical cloud verification. This task ran no cloud deployment or live-provider mutation. Historical fast-private cloud attribution remains INCONCLUSIVE.

## Imports and owned changes

The starting commit is root `185ecea`. The nine requested commits were cherry-picked exactly once, in the supplied order. Their local mappings are:

- `b2475ea` to `9347cf4`.
- `613b72f` to `9f2434f`.
- `2403d3e` to `b8d7402`.
- `e2e270a` to `83881b8`.
- `c16a3cf` to `17cb050`.
- `3b74ae0` to `dd5f0e0`.
- `f32ae19` to `c18a012`.
- `724ec90` to `82b0820`.
- `37d0e19` to `ffc7757`.

`12d9bf8` commits the new failing regressions. `57c0f56` changes one account condition. This evidence document is the final commit. The only task changes after the imports are `apps/bot/test/twitch-deadline.test.ts`, `apps/bot/src/twitch-account.ts`, and this file.

The candidate checkout `/home/angel/.t3/worktrees/arc-tools/t3-8785aacf` was not modified. Root-owned `.audit`, `docs/cloudflare-migration-plan.md`, `docs/ingress-design-review.md`, and `docs/verification/tenant-ingress-root-review.md` match `185ecea`. Imported `tenant-corrections.md` and `tenant-ingress.md` remain unchanged. No delegate was launched under the single-writer brief.

## Reproduction and correction

The data shape remains the existing `Dispatch`, with its branded attempt, broadcaster, parent, text, and absolute deadline. Tenant derives the cutoff once from the verified Worker receipt. Account dispatch previously also required `deadline <= first + 10_000`, where `first` came from its own clock. A legitimate Worker receipt ahead by one millisecond therefore caused terminal rejection before any account attempt record or external POST. Duplicate ingress retained that rejection and could not repair it.

The correction removes only `valid.deadline > first + 10_000` from the account's initial rejection condition. `current(state)` remains required. No receipt field, second timestamp, skew allowance, new API, deadline clamp, restamp, or retry policy is added. The account still decodes every Dispatch at its RPC service boundary. Its read and claim expiry checks and the provider's own pre-POST clock check all retain the original epoch deadline.

Fix Root Causes removes the invalid cross-actor synchronization assumption. Boundary Discipline preserves ingress and namespace RPC schema validation. Model the Domain keeps the existing immutable dispatch plan. Laziness Protocol limits the production change to one condition. Sequence Work into Verifiable Units puts the failing tests before the fix. Test Behavior, Not Implementation and Prove It Works require the signed handler, real account policy, actual HTTP POST counts, and persisted values.

## Full-path regression evidence

`apps/bot/test/twitch-deadline.test.ts` runs real signed raw HttpApi ingress, production `makeTenant`, production `makeAccount`, and production `makeProvider`. It reuses the existing Tenant storage/data fixture and subscription HTTP fixture. OAuth grants and an enabled subscription are established through production policy before ingress. The account adapter forwards status, subscription observations, and dispatch to that account; it never substitutes a successful dispatch result. Only external Twitch HTTP responses and storage are local fixtures. These tests do not claim native Cloudflare storage or alarm proof.

The test passes the controlled Worker receipt to the same `ingressHandlers` construction used by Worker fetch. Tenant and account have independent controlled epoch clocks. Provider execution uses the account's clock. Monotonic time and sleep remain with the test runtime. The suite observes `POST /chat/messages` at the local HTTP server and its exact body, alongside persisted Tenant work and the production account ledger.

The seven send controls use Worker, Tenant, and account clock values in that order. Each number below is milliseconds. The before and after counts include duplicate signed ingress and recovery:

- `0 / 0 / 0` retains receipt `0` and cutoff `10000`. Before and after each produce one POST.
- `1 / 0 / 0` retains receipt `1` and cutoff `10001`. Before produces zero POSTs and terminal rejection with no account attempt. After produces one POST and terminal sent.
- `20 / 0 / 0` retains receipt `20` and cutoff `10020`. Before produces zero POSTs and terminal rejection with no account attempt. After produces one POST and terminal sent.
- `20 / 0 / 20` isolates a trailing Tenant clock. Before and after each produce one POST with cutoff `10020`.
- `20 / 40 / 20` isolates a leading Tenant clock. Before and after each produce one POST with cutoff `10020`.
- `20 / 20 / 0` isolates a trailing account clock. Before produces zero POSTs and terminal rejection with no account attempt. After produces one POST and terminal sent with cutoff `10020`.
- `20 / 20 / 40` isolates a leading account clock. Before and after each produce one POST with cutoff `10020`.

Every successful case sends `ARC: Sensors can be sold for 10 coins each` to broadcaster `200` from sender `100`, with parent `original-parent` and `for_source_only: true`. The persisted plan uses `${work.id}:0`, that exact parent/text, and the original cutoff. A duplicate notification with a later Worker receipt preserves the complete terminal work, performs no second dispatch or POST, and does not reload the source. The account ledger retains the same cutoff after success. Recovery leaves no Tenant alarm.

For both Tenant and account clocks at `10020` and `10021`, an acknowledged receipt of `20` becomes terminal expired and starts zero POSTs. Duplicate ingress and recovery still start zero. Separately, admission when the Tenant clock is already at either value returns 503, creates no work or account attempt, loads no source, and starts zero POSTs. These equality and absolute-expired controls pass before and after the fix.

The safe-retry control has Worker receipt `20`, Tenant time `40`, and account time `0`. Before the correction it is terminal rejected with zero POSTs. After correction the actual first POST receives HTTP 429. Both Tenant and account persist waiting state with cutoff `10020` and retry time `1000`. Duplicate ingress starts no extra POST. Recovery with Tenant time `1020` and account time `1000` sends the exact same dispatch and HTTP body. The second POST succeeds. The total is two POSTs, comprising one explicit rejection and one successful message. The attempt ID, parent, text, and cutoff remain unchanged. Later duplicate ingress and recovery leave the total at two.

A configuration revision mismatch after signed admission still rejects before any POST or account attempt. An exact account replay after a valid signed dispatch reads the original success without another POST. Changes to its text, parent, or deadline reject against the persisted fingerprint. Empty text, 501-character text, and an overlong attempt ID still fail with `AccountError(input)` and create no extra POST or attempt.

The focused failing run at the regression commit reports:

```text
 12 pass
 4 fail
 136 expect() calls
Ran 16 tests across 1 file. [1450.00ms]
```

The same test file after the one-condition fix reports:

```text
 16 pass
 0 fail
 159 expect() calls
Ran 16 tests across 1 file. [1461.00ms]
```

The extra assertions after correction come from the formerly failing cases reaching their remaining contract checks. These durations are whole test-run observations, not provider latency or performance claims. Logs retain the before-run diffs showing `posts: 0`, `ledger: []`, and terminal `rejected` with unchanged `10001` or `10020` cutoffs.

## Source census and ownership

The census covered every production source file under `apps/bot/src` and `packages/commands/src`, with an additional source-wide search under `apps` and `packages` for upper-window comparisons. Rerunnable searches are:

```bash
rg -n -i 'deadline|cutoff|receivedAt|10_000|10000|future|skew' apps/bot/src packages/commands/src
rg -n '(deadline|cutoff).*[><].*\+|(receivedAt|deadline)\s*>' apps packages --glob '*.ts' --glob '!**/dist/**' --glob '!**/node_modules/**'
```

The second search returns no matches after correction. The only removed upper-window assumption was `twitch-account.ts` at line 717. The detailed census is retained locally in `.cloud-tests/twitch-deadline/deadline-census-{before,after}.txt`.

- `worker.ts` stamps `Date.now()` at the start of fetch before client resolution and body handling. It supplies the stamp to ingress. It does not derive the Twitch send deadline.
- `ingress.ts` verifies raw signatures and timestamp freshness, then constructs the receipt with the original Worker stamp. Its future signature allowance concerns a signed external timestamp, not clock equality between internal actors. No public HTTP dispatch mutation exists; ingress calls the internal Tenant service.
- `tenant.ts` admission at lines 380-389 solely constructs the authoritative Twitch cutoff as `receivedAt + 10_000`. Duplicates return the original record before deadline construction. The base-state copier, presentation plan, and terminal states retain its exact stamp and cutoff. Diagnostic envelopes separately report the same cutoff without changing work.
- `tenant.ts` checks the existing deadline at admission, computation completion, recovery claim, and immediately before account dispatch. Its timeout, claim, retry, multipart, and live-operation join bounds use that same cutoff. Equality stops work. `tenant-state.ts` selects an alarm from existing action times and the deadline; that scheduling minimum does not rewrite the deadline.
- `twitch-contracts.ts` and `contracts.ts` retain the public Dispatch shape and nonnegative-integer deadline schema. `twitch.ts` retains namespace RPC forwarding and result encoding. `makeAccount` still decodes Dispatch before fingerprinting or any account/provider operation.
- `twitch-account.ts` still checks `first >= valid.deadline` at initial read and `now >= valid.deadline` at claim after credential work. Attempt fingerprints cover the entire decoded dispatch. Every waiting, sending, and terminal attempt copies `valid.deadline`; safe retry and rate decisions stay strictly before it. Credential leases, grants, authorization, shared reservations, ambiguity handling, retention, and configuration checks are unchanged.
- `twitch-provider.ts` still reads its own `Clock.currentTimeMillis` immediately before the chat POST and returns expired at `now >= input.deadline`. It still bounds HTTP I/O by `min(4_000, input.deadline - now)`. `provider-http.ts` bounds the request without constructing a new deadline.
- `packages/commands/src/execute.ts` computes remaining time from the supplied epoch deadline and rechecks it after computation. The `budgets.twitchSendCutoffMs` declaration and account credential lease duration are constants, not competing send-deadline constructors. No centralization or framework change was needed.

## Local verification and retained commands

Every command uses the pinned directory first in PATH, including all Turbo children:

```bash
export PATH=/home/angel/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin:$PATH
bun --version
bun install --frozen-lockfile
TURBO_FORCE=true bun run test
bun test apps/bot/test/twitch-deadline.test.ts
TURBO_FORCE=true bun run build
TURBO_FORCE=true bun run check-types
TURBO_FORCE=true bun run lint
git diff --check
```

The initial baseline command stopped at `turbo: command not found` because the isolated checkout had no `node_modules`. Frozen-lockfile installation succeeded under Bun `1.3.5` without a manifest or lockfile change. The rerun baseline passed all 295 tests and 1,413 assertions before the new tests or application edit. The first regression typecheck caught branded expected literals and a potentially absent captured dispatch. The tests were corrected and typechecked successfully before the failing regression commit. Those setup/type failures remain in the local logs.

Final uncached default results on application commit `57c0f56` are:

- Tests pass all 311 cases and 1,572 assertions. This preserves all 295 inherited cases and adds 16 full-path cases. Workspace totals are bot 154 tests with 1,140 assertions, arc-data 34 with 117, commands 71 with 119, utils 27 with 39, Discord bot 12 with 73, and Twitch bot five with 11. The default command also passes all eight root strict-HTTP/response cases with 73 assertions.
- Build passes four tasks with zero cached tasks.
- Typechecking passes seven workspace tasks with zero cached tasks, followed by successful root `tsc --noEmit` through the unchanged default command.
- Lint passes its uncached root task and checks 145 files without edits.
- `git diff --check` passes. The implementation diff contains only the account condition and new test file. Neither contains a new comment or suppression. Root's independent comment review remains pending.

All command outputs are retained under `.cloud-tests/twitch-deadline/`. `baseline-tests.log` holds the missing-Turbo failure, `install.log` the frozen installation, and `baseline-tests-installed.log` the passing baseline. `before-commit.log` and `after.log` hold the failing and passing focused runs. `regression-types.log` retains the initial typecheck failure and `regression-final-types.log` its passing correction. `final-{tests,build,types,lint}.log` retain the full final gates. A local `decisions.tsv` records the main choices. The logs are ignored working artifacts; this committed document preserves their concrete results and commands.

The following preservation checks pass:

```bash
git diff --exit-code 185ecea HEAD -- .audit docs/cloudflare-migration-plan.md docs/ingress-design-review.md docs/verification/tenant-ingress-root-review.md
git diff --exit-code 37d0e19 ffc7757 -- apps packages tests scripts alchemy.run.ts bun.lock package.json biome.json
git diff --exit-code ffc7757 HEAD -- docs/verification/tenant-corrections.md docs/verification/tenant-ingress.md
```

## Remaining gates

Root must run fresh technical and comment review of this correction and fresh exact-revision canonical cloud verification before accepting or integrating Unit 3. The prior owner and root 29-case/631-assertion cloud passes do not cover these newly controlled clock differences. This task neither reran them nor changed their retained failures, successful journals, or cleanup evidence. It created no deployment to tear down.

Live Twitch delivery/timing, Discord client privacy/timing, onboarding-token-expiry grant survival, operating cost, release/CI completion, Unit 5 legacy deletion, and overall migration acceptance remain open. No persistent staging or production deployment, live Twitch/Discord mutation, external message, push, PR, dependency change, or legacy deletion occurred.
