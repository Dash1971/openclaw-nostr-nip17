# Nostr NIP-17 reconnect hardening review brief

Status: implementation revised for another independent re-review; merge and deployment are not approved by this document. See [the independent review](20260909_independent_review.md), [the first implementation follow-up](20260909_v0_review_followup.md), and [the second review follow-up](20260909_v1_review_followup.md).

## References

- Repository: https://github.com/Dash1971/openclaw-nostr-nip17
- Branch: fix/reconnect-hardening
- Baseline: 061325a8f0a36e85fcdd4214c2529503299a0946
- Latest implementation examined: 73e6b200839e2e3f59daf6482cf9cfcca660275f
- [Public deployment design requirements](20260909_v0_gateway_nostr_repair_plan.md)

## Transport problem

The baseline creates a multi-relay subscription whose close handler records errors but does not establish a replacement. When all underlying subscriptions close, the channel can remain reported as running without receiving new messages.

Outbound delivery previously returned after the first eligible relay accepted the reply. Publishing to all eligible recipient-advertised inbox relays can improve visibility for clients reading different relays.

## Proposed implementation

- Independent subscription supervisors per configured relay.
- Exponential retry delays with jitter and one pending reconnect timer per supervisor.
- Generation checks that ignore callbacks from superseded subscriptions.
- Explicit stop cancellation of connection and reconnect timers.
- A startup health timeout when no event or EOSE arrives.
- Aggregate connecting, healthy, degraded, unhealthy, and stopped states.
- Usable connectivity when at least one configured relay is healthy.
- NIP-42 signing for authenticated relay operations.
- Concurrent reply publication to eligible recipient inbox relays, succeeding when at least one accepts.
- Separate verified rumor-ID claims and persisted startup dedupe seeds.

## Review status

Independent review confirmed the partial-coverage connectivity fix and identified idle-health, replay-retention, ownership, and shutdown problems. The current candidate responds with explicit null transport-heartbeat semantics, timestamped durable rumor retention, corrected claim ownership, and awaited full-pool shutdown. These corrections and their new tests still require independent confirmation.

The implementation retains NIP-17 verification, encryption, sender policy, TOTP gating, size/rate limits, and publication circuit breakers. This statement describes intended preservation, not a complete security audit.

## Validation reported by the implementation author

The earlier candidate reported 27 passing tests across nine files, a passing TypeScript check, a clean diff check, and a controlled local WebSocket reconnect test. Updated validation totals for the current candidate are recorded in the follow-up commit and PR checks; the independent reviewer has not yet assessed them.

## Review priorities

1. Re-review idle transport semantics and timestamp handling.
2. Re-review replay retention across lookback, eviction, expiry, and restart boundaries.
3. Re-review in-flight ownership and awaited full-pool shutdown.
4. Make the externally supervised deployment contract explicit across all lifecycle entry points in private deployment work.
5. Keep the resulting implementation commit immutable for review and stage outside active plugin paths.

Deployment-specific procedures, logs, privileged command details, and approvals belong in a private operator runbook.
