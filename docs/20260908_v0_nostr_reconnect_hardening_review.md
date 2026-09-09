# Nostr NIP-17 reconnect hardening review brief

Status: implementation under independent review; merge and deployment are not approved by this document. See [the independent review](20260909_independent_review.md) for outstanding defects.

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

Independent review confirmed the partial-coverage connectivity fix and identified unresolved idle-health and replay-retention problems. The startup timeout, full shutdown behavior, and interaction with the host lifecycle also require appropriate integration evidence. Adding persisted rumor IDs does not by itself establish replay protection beyond cache expiration.

The implementation retains NIP-17 verification, encryption, sender policy, TOTP gating, size/rate limits, and publication circuit breakers. This statement describes intended preservation, not a complete security audit.

## Validation reported by the implementation author

Against Node 24 and locked dependencies:
- 27 tests passed across nine files.
- TypeScript check passed.
- Diff whitespace check passed.
- A controlled local WebSocket test verifies recovery of one failed endpoint while another stays connected, followed by explicit stop.

The independent reviewer inspected the tests and ran focused source-based checks, but did not rerun the complete suite. The supervisor test is not a full gateway, persistence, or end-to-end transport validation.

## Review priorities

1. Correct idle transport liveness and timestamp precedence.
2. Align replay retention with reconnect lookback, capacity eviction, and restart boundaries.
3. Correct in-flight entry ownership and test full-handler deduplication.
4. Test startup/abort, pending replies, discovered-relay cleanup, and shutdown.
5. Make the externally supervised deployment contract explicit across all lifecycle entry points.
6. Keep implementation commits immutable for review and stage outside active plugin paths.

Deployment-specific procedures, logs, privileged command details, and approvals belong in a private operator runbook.
