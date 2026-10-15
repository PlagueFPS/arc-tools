# Migration verification records

Each implementation unit records the exact revision, commands, actual output, cloud test-stage identity, teardown result, and remaining gates. Never include secret values or token-bearing URLs.

A unit is VERIFIED only when its required behavior has been exercised. Compilation and package metadata alone do not prove cloud behavior. A blocked cloud run remains NOT VERIFIED or INCONCLUSIVE, even when local checks pass.

The foundation owner starts with `foundation.md`. Later units add records for cache, ingress and tenants, Twitch and registration, and final integration. Root independently inspects the artifacts and requests a read-only review before accepting each unit.

Disposable test infrastructure uses unique stage names and Cloudflare-backed state. Cleanup failures are recorded alongside test failures. Real provider tests use nonproduction application identities and the personal Twitch channel.
