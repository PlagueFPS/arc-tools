# Migration verification records

Root accepted and integrated implementation Units 1, 2, 4, and 3. Those acceptances establish their reviewed implementation and executed controlled-provider gates. Complete migration acceptance remains open until final integration review and the separate live-provider gates pass.

| Record | Current reading |
| --- | --- |
| [Foundation root review](foundation-root-review.md) | Accepted foundation, raw HttpApi, native storage, reconstruction, and alarms. |
| [Cache root review](cache-root-review.md) | Accepted cache and absolute command-deadline correction. |
| [Twitch and release root review](twitch-release-root-review.md) | Its final section accepts the corrected account and release implementation. Earlier failures remain historical. |
| [Tenant and ingress root review](tenant-ingress-root-review.md) | Its final section accepts ingress, Tenant execution, recovery, and cross-service deadline corrections. Integrated-root frozen installation and the subsequent 311-test/1,572-assertion pass are recorded separately from the initial missing-link setup failure. |
| [Final integration](final-integration.md) | Unit 5 deletion, current configuration/docs, health, local workerd, final checks, and disposable-cloud evidence. Root review remains separate. |
| [Cloud helper evidence](cloud-harness.md) | Strict pre-execution readiness classification, native reconstruction, retained failures, and default discovery of all eight pure helper tests. |
| [Tenant corrections](tenant-corrections.md) | Historical failures and corrected native recovery, allocation observation, and live-dispatch joining. |
| [Twitch deadline correction](twitch-deadline-contract.md) | Sixteen full signed-path clock tests and the narrow account correction. Later acceptance is in the root review. |

Owner records describe the revision and review state at which they were written. Read their later root reviews for acceptance. Historical failed deployments, setup failures, counts, and inconclusive causes remain evidence; a subsequent pass does not erase them.

Disposable cloud tests use unique per-worktree/run stages, real Workers and SQLite Durable Objects, Cloudflare-backed state, production application policy, and controlled HTTPS external providers. Every run records exact checks and verified destruction. The state control backend remains separate and retained. Local workerd proves interactive development only.

Live Twitch authorization/EventSub delivery and timing, grants after onboarding-token expiry, Discord client privacy/registration/timing, remote CI/release configuration and execution, and observed launch cost remain NOT VERIFIED. Controlled-provider payloads and latency observations do not establish those live gates. Concrete next checks are in [final integration](final-integration.md) and [the operator guide](../operator-guide.md). Do not put secret values or token-bearing authorization URLs in verification records.
