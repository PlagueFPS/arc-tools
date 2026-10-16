# Concrete ingress design review

Unit 4 is accepted and integrated. Unit 3 remains in architecture. The approved product and protocol requirements in `cloudflare-migration-plan.md` remain authoritative.

## Candidate B received

Gemini's candidate `cloudflare-ingress-concrete-design-b-r1` proposes separate admission and execution calls for Twitch, with an opportunistic `waitUntil` execution call backed by a durable alarm. Discord duplicates would poll persisted work until the original execution deadline. Namespace discovery and runtime client resolution follow the accepted account binding pattern.

Root rejects these details before synthesis:

- The proposed Twitch attempt ID `${workId}:${generation}` changes on recovery. After the account sends a reply but before the tenant commits completion, a recovered generation could use a new ID and send again. The account ledger deduplicates only the same complete dispatch input and attempt ID. Freeze the rendered delivery plan before sending; IDs derive from immutable work identity and chunk index, independently of computation generations. Persist that plan before the first dispatch. Recovery reads the same account attempt.
- Scheduling recovery only at the work deadline prevents useful crash recovery within the ten-second window. The alarm must cover the earliest actual next action, including a computation lease expiry or retry time strictly before the original deadline. Admission must persist that alarm before acknowledging.
- FIFO pruning at 64 records could remove a still-live replay tombstone and admit an earlier event again. Bound capacity by rejecting new admission or reclaiming expired records, without shortening the promised replay retention.
- Single concise fixture responses do not prove a maximum for arbitrary validated upstream data. Inspect collection and string bounds and define transport presentation for longer results. Do not truncate silently or assert all outputs fit without proof.
- Storage polling every 50 milliseconds is not established as costless. Compare its bounded work and cancellation behavior with a scoped duplicate join or deterministic terminal fallback. Durable records remain authoritative regardless of any in-memory optimization.

The candidate does not yet resolve the concrete controlled-provider binding through the actual Bot or the Bot callback origin dependency. Those are implementation prerequisites, not user product questions. Candidate A remains active. No synthesis or Unit 3 application implementation is accepted yet.
