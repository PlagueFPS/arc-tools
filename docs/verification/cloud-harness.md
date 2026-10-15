# Cloud test transport and reconstruction evidence

This is a test-harness correction on top of unit 4, cherry-picked as `c204d2c` from `4988f00b5d3ffe53abff89f6331ff1bb8f82b6dd`. The worker branch starts at root `c260bc1`. Application code, account policy, provider adapters, release workflows, stack wiring, manifests, and the approved migration plan are unchanged by this correction. Root owns independent review and acceptance.

## Failure evidence and causal limits

Root's `bunx bun@1.3.5 run scripts/cloud-test.ts account` in the original worktree produced stage `test-account-a0e65c16-56ec6e796e36`, with 11 passes, three failures, and 203 assertions. All six account and release cases passed. Its cleanup verified zero Workers, zero Durable Object namespaces, and absent stage state and output.

The reconstruction assertion saw the original UUID `341b965d-4b52-4ba4-af62-8ac5c62be80f` after an unchecked reset POST. The harness discarded the reset response and suppressed every RPC cause. Its `Effect.retry` retried snapshot errors but did not repeat a successful unchanged snapshot. Root later observed UUID `83662b9e-0c0d-4305-8f2e-0fa0f120cb73` with the same committed state. The original evidence cannot establish whether reset failed to reach the route or reconstruction completed later. Neither hypothesis is recorded as fact.

The alarm test decoded a 404 HTML response from `POST /arm` as JSON. Its resulting `Unexpected '<'` was a transport-status handling defect, before alarm assertions ran. The cache helper classified every POST 404 as `FixtureRouteNotReady` and retried four times at 200 milliseconds. It recorded neither the failing route nor the body fingerprint. The original cache failure's exact route and pre-execution status cannot be reconstructed from that log. GET snapshot readiness did not prove POST readiness.

The original worktree and its journals were read-only. Copies are retained under `.cloud-tests/root-failure/` in this worker's checkout. The original log SHA-256 is `2f304253bdd91998a11c61dab1b143ee6075da959a34359ae95e93b84e4fb4e2`. The run, resources, and result journal hashes are `b820944c3db174a77f7206c883b319f7111bc86c9e2d36902b4146d23cff8246`, `d1fa8061777f12b1acf6f3a12f5f44158f86f3a6dd31bb6e01d92cf26f3dab19`, and `a971e4b00661d3d8b8f848f6c0efd4f3a8113dcb709a95e86ff943524a30576c`.

## HTTP classification and reconstruction

`tests/cloud/fixture-http.ts` owns the fixture HTTP boundary. Foundation, cache, and account callers share status checks, JSON content-type checks, and schema decoding. Fixture responses identify execution with `x-arc-cloud-fixture: v1`. Diagnostics contain method, hostname and pathname, exact status and content type, Cloudflare ray, fixture marker, response length, and SHA-256. They omit query parameters, request bodies, authorization headers, and response bodies. Redirects are not followed.

A focused diagnostic deployed disposable stage `test-account-15e5217e-d48e1d6441a0` and made 20 GET snapshots, 20 POST echoes, and 20 POST requests to an unknown fixture route. Known routes returned 200. The unknown route returned 404 with no content type and an empty body. The transient 404 HTML was not reproduced during this diagnostic. Its log is `.cloud-tests/transport-diagnostic.log` and its source is `.cloud-tests/transport.test.ts`. Its single diagnostic test passed and cleanup verified zero Workers and namespaces with absent state and output.

Read-only GET and no-op POST requests to the already deleted root stage's Worker URL independently returned Cloudflare's missing-Worker page. Both responses were 404, `text/html; charset=UTF-8`, `server: cloudflare`, and 19,984 bytes. The page's title was `Page not found`. Its SHA-256 was `2000e6b28a1517ba1268e1649cd3163326ef839492edfdba31e8959830580976`. The safe metadata is retained in `.cloud-tests/deleted-route-diagnostic.jsonl`. These observations identify a pre-execution infrastructure response. They do not establish the original cache response's fingerprint.

Only that exact response hash, 404 status, HTML content type, Cloudflare server header, absent fixture marker, and a disposable test Worker hostname authorize readiness retry. The helper allows at most 15 retries spaced one second apart, with a 20-second total request budget. A read-only request to the deleted Worker exercised all 16 attempts and then failed. Its log is `.cloud-tests/bounded-readiness-diagnostic.log`. A changed Cloudflare page fails rather than broadening the classification automatically.

Other 404s, all 500s, redirects, unknown transport execution, wrong JSON content types, malformed JSON, and business-schema failures stop immediately. No test body or business assertion is retried. This helper does not wrap HTTP performed by application provider adapters.

`tests/cloud/fixture-response.ts` accepts only the requested native abort reason wrapped in Alchemy's `RpcCallError`. Unexpected causes propagate. A reset RPC that returns without aborting fails. Callers check the successful 204 acknowledgement. [Cloudflare documents that abort resets the object and rejects the active execution](https://developers.cloudflare.com/durable-objects/api/state/#abort). The pinned Alchemy adapter wraps a rejected native RPC in `RpcCallError` in `node_modules/alchemy/src/Cloudflare/Workers/Rpc.ts`.

After acknowledgement, `reconstructedSnapshot` observes the UUID condition, up to 21 snapshots at 100-millisecond intervals within five seconds. A snapshot error stops the poll. The UUID must change, and the original committed value, rollback counters, persisted alarm timestamp, alarm completion count, and retry count assertions remain. Polling is a bounded observation of the requested lifecycle event. It does not establish that delayed reconstruction caused the original failure.

## Verification

The throughput checkpoint was to classify the captured failure, separate reached-fixture errors from the missing-Worker page, check reconstruction acknowledgement, run local regressions, then run one changed combined real-cloud account suite with independent teardown verification. No worker delegated further work. Architecture and comment-review fan-outs were omitted under the explicit no-delegation instruction.

Local checks used Bun 1.3.5, Effect 4.0.4, and Alchemy 2.0.0-beta.83.

```text
bunx bun@1.3.5 install --frozen-lockfile
Frozen install passed, no manifest or lockfile changes.

bunx bun@1.3.5 run build
4 successful tasks.

bunx bun@1.3.5 run check-types
7 successful workspace tasks and root tsc --noEmit passed.

bunx bun@1.3.5 run lint
Biome checked 123 files without changes or errors.

bunx bun@1.3.5 test ./tests/cloud/fixture-http.test.ts ./tests/cloud/fixture-response.test.ts
8 pass, 0 fail, 73 assertions.

bunx bun@1.3.5 test ./packages/utils/test ./packages/arc-data/test ./packages/commands/test ./apps/discord-bot/test ./apps/twitch-bot/test ./apps/bot/test ./tests/cloud/fixture-http.test.ts ./tests/cloud/fixture-response.test.ts
189 pass, 0 fail, 653 assertions across 26 files.
All 181 existing local tests remain.
```

The eight regressions cover the exact route-classification restrictions, POST replay prevention on reached-fixture and unknown edge failures, ambiguous transport loss, parse and schema failure, byte preservation, old-old-new UUID observation, bounded unchanged-UUID failure, snapshot-error propagation, and exact abort acknowledgement. They use local HTTP response values and virtual time. They do not emulate Cloudflare storage or claim real-cloud proof.

The first changed combined run, stage `test-account-15e5217e-ccd040f6efe3`, passed all 14 tests and 222 assertions. It captured a 404 on the first account-fixture GET `/snapshot`, followed by a 200 JSON response on retry. The failed response matched the observed placeholder hash, had the HTML content type, and lacked the fixture marker. The runner and cleanup both returned zero. Cleanup independently verified zero Workers, zero namespaces, and absent state and output.

Review then restored the original snapshot helpers' exact HTTP 200 requirement in the shared JSON decoder. A regression now rejects a schema-compatible 201 without retry. The final combined run verified that stricter decoder rather than relying on the earlier pass.

```text
bunx bun@1.3.5 run scripts/cloud-test.ts account
Final stage test-account-15e5217e-e077475f24a3.
14 pass, 0 fail, 222 assertions.
Cloud tests exit 0; cleanup exit 0.
CLEANUP VERIFIED: zero matching Workers, zero DO namespaces,
no stage state/output; control backend retained.
```

The final run reproduced missing-Worker HTML on cache POST `/clear`, `/read`, `/time`, and `/reconstruct`, and GET `/snapshot`, interspersed with successful responses from the same cache Worker. Each failed response had the exact pinned hash, 404 status, HTML content type, Cloudflare server header, and no fixture marker. Subsequent bounded retries returned the expected 200 JSON or 204 with the fixture marker. This establishes pre-execution route unavailability in the matching cloud transport. It does not identify Cloudflare's internal routing cause or retroactively supply the missing metadata from root's first run.

For example, POST `/clear` returned placeholder ray `a4b19ba0880ed4c1-IAD` after cache snapshot success. The next POST `/clear` returned 204 with `x-arc-cloud-fixture: v1`. POST `/reconstruct` returned placeholder ray `a4b19bf11fe3d4c1-IAD`, then 204 with ray `a4b19bf81a85d4c1-IAD` and the fixture marker. The final run classified ten placeholder responses, including later account POSTs, by the same strict rule. The intentionally interrupted account setup and dispatch requests returned 500 and remained failures for their existing interrupted-operation assertions. No generic 404 or 500 was retried.

Both changed combined runs retained all original domain assertions. The lower assertion counter reflects HTTP status checks moved from repeated `expect` calls into the shared fail-fast boundary. JSON requires exact 200, reset explicitly requires 204, and schema decoding remains strict. Foundation UUID, rollback, persisted value, alarm timestamp, native alarm attempts and retry count checks remain. The alarm case additionally verifies reconstruction before waiting for native completion.

Every final cloud UUID poll observed a different UUID on its first successful snapshot. No delayed reconstruction was demonstrated. The helper's old-old-new and unchanged conditions are covered deterministically, and the live UUID changes still prove native reconstruction and persisted state.

The two combined runs and diagnostic deployment each retain `run.json`, `resources.json`, `result.json`, and `console.log` under `.cloud-tests/<stage>/`. Local check logs and the focused decision trail are under `.cloud-tests/`. The final console log is also `.cloud-tests/account-harness-final.log`. No failed result was overwritten or discarded.

## Handoff

The worktree is `/home/angel/.t3/worktrees/arc-tools/t3-d1243984`, branch `t3/d1243984`. Cherry-pick the harness correction after unit 4. The helper regression command above is explicit because the existing Turborepo workspace test command does not discover `tests/cloud/*.test.ts`. No CI or workspace-manifest change was made in this narrow fix. Root retains independent review and rerun.

## Scope

Fix Root Causes removed unchecked transport results and broad cause suppression. Model the Domain selected separate route-readiness and terminal HTTP errors. Boundary Discipline put response validation before JSON decoding. Prove It Works required the changed combined cloud run, native UUID transitions, strict persisted-state assertions, and API cleanup verification.

Root's original failures remain retained evidence. The matching cloud run establishes pre-execution route unavailability. The original reset cause and the original cache response fingerprint remain unknown. No application defect has been established by this worker. No real Twitch or Discord mutation, persistent staging deployment, production deployment, root audit edit, migration acceptance, or unit-4 acceptance is claimed.
