# Effect review comment resolution

All 62 submitted comments received an implementation or an API-specific disposition. The accepted source changes end at `6832a5f`.

| Comment IDs                                   | Resolution                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 3, 6, 42–47, 49, 62                        | Tagged error discrimination replaces class identity checks. Unknown ingress errors use schema guards.                                                |
| 2                                             | Discord retry seconds decode into a finite positive `Duration`, with upward millisecond rounding and the existing attempt and deadline limits.       |
| 4, 10                                         | Ingress imports are consolidated and configuration has a named readonly interface.                                                                   |
| 5, 19, 24–31, 33–36, 41, 50–57, 59–61, 63, 65 | Effect predicates replace the requested presence and property checks.                                                                                |
| 7                                             | Authentication header schemas preserve signed timestamp text and return 401 for invalid authentication headers.                                      |
| 8                                             | `Hex.decode` replaces manual hex parsing. Native WebCrypto retains HMAC and Ed25519 verification because Effect 4.0.4 Crypto lacks those operations. |
| 9                                             | Fatal UTF-8 decoding remains. `Hex.decodeString` accepts hex text and does not preserve strict decoding of raw HTTP bytes.                           |
| 11, 18, 21–23, 32, 37, 38, 40                 | `Match` handles the requested delivery and state variants.                                                                                           |
| 12, 20                                        | `Result.isFailure` replaces manual Result tag checks.                                                                                                |
| 13                                            | Slash options trim before empty values become empty arrays. This permits removal of `filter(Boolean)` while preserving whitespace normalization.     |
| 15                                            | Generated Twitch replies omit ARC branding, including fallback and multipart replies. Multipart position labels remain.                              |
| 16                                            | A scoped Effect HTTP client preserves received statuses, bounded response reads, cancellation, manual redirects, and single attempts.                |
| 17                                            | Effect Crypto and Hex produce the existing lowercase SHA-256 fingerprints through a local WebCrypto binding.                                         |
| 48                                            | The unused configuration copy is removed.                                                                                                            |
| 64                                            | Bot contracts reuse the commands package's authoritative command-name schema.                                                                        |

The supplied comment IDs omit 14, 39, and 58.

## HTTP verification boundary

The earlier immediate-close TCP test sometimes failed before native Bun fetch returned a `Response`. A separate native-fetch trace captured `ECONNRESET` despite received headers in transport diagnostics. This also occurred before the HTTP refactor. The application cannot recover a status that fetch does not return.

Commit `6832a5f` separates these outcomes without changing production code. A real TCP fixture first observes the native `Response`, then truncates the body before releasing the response to the adapter. The 401 case requires the original status, a null body, zero application body accesses, an aborted signal, and exactly one fetch and wire request. Paired 200 and 429 cases require body access and a network failure. A separate injected fetch rejection requires a network failure after one attempt and permits no invented status.

Five mutation checks rejected removed status handling, forbidden body reads, skipped accepted-body reads, retries, and invented status. Independent review accepted the corrected proof and closed comment 16. The captured immediate-close failure remains a known Bun transport behavior.

## Review record

The data and schema group passed independent review before integration. The account and tenant group also passed independently. Protocol review accepted fifteen comments, held comment 16 for the HTTP proof, then accepted the corrected test in a fresh review round. Each group passed its separate comment audit.

Root independently ran 143 data and command tests, 155 account and tenant tests, 64 protocol tests before the proof correction, and all 26 corrected HTTP tests. Combined verification results are recorded in `.audit/effect-review-comments.tsv`.

The integrated checkout passed `bun run test` with 353 tests and 1,943 assertions. It also passed `bun run check-types`, `bun run build`, `bun run format-and-lint`, and `git diff --check`, using Bun 1.3.5. Biome checked 129 files without changes. The user's existing `.env.example` patch remained unchanged.

The canonical `bun run scripts/cloud-test.ts tenant` run passed 29 cases with 637 assertions at stage `test-tenant-18c32360-748ffc48f1b4`. It exercised real Cloudflare Workers and Durable Objects with synthetic external providers. Cleanup independently confirmed zero stage Workers, zero Durable Object namespaces, and absent state entries and output. The shared state control backend remains retained. Both test and cleanup exit codes were zero.
