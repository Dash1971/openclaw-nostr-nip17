# Reconnect hardening third review follow-up

Status: reviewed at commit `df0a05472cc5ce1586787816225188c545682e7d`; changes were requested. The response is documented in [the fourth review follow-up](20260909_v3_review_followup.md). This document does not approve merge or deployment.

## Review addressed

This revision responds to the independent re-review of commit `9ab569aad883e455c6c54092a4a3b4fd741464df`. The review identified four remaining recovery boundaries: transport timeout callbacks were indistinguishable from wire EOSE, failed or rate-limited deliveries could be hidden by settled promises, an old checkpoint could outlive rumor retention, and inbox discovery could finish after shutdown and begin a late publication. All four are addressed with deterministic regression coverage.

## Wire EOSE certification

The locked transport invokes the same `oneose` callback for a relay's wire EOSE and its local timeout. Subscriptions now use a transport timeout longer than the independent subscription-health deadline and reject EOSE callbacks at or after that transport deadline. A local relay regression deliberately withholds wire EOSE, crosses the dependency's former 4.4-second timeout boundary, then supplies a valid backlog event and verifies that the durable checkpoint never advanced.

The health supervisor still declares a subscription unhealthy after 30 seconds and reconnects it independently. A timeout callback is therefore not used as evidence that backlog delivery completed.

## Retryable delivery outcomes

The bus now records retryable outer-event IDs for transient handler failures, future-skew deferrals, and global or per-sender rate limiting. Catch-up cannot advance while any event observed in the current lifecycle remains retryable. Successfully processed or terminally rejected events remove their retryable marker.

One integration test makes the message handler fail, confirms that neither the checkpoint nor durable replay state advances past that message, restarts the bus, and verifies successful redelivery. A separate test exhausts the global rate limit before genuine wire EOSE and confirms that the checkpoint remains at the prior durable boundary.

## Dedupe retention follows the query horizon

Persisted rumor records now include the latest verified gift-wrap timestamp. An entry is retained while that timestamp remains inside the bus's durable replay query window, even if wall-clock retention has elapsed. It becomes eligible for pruning only after the catch-up checkpoint moves the corresponding wrap outside the query range and the normal retention interval has elapsed.

Legacy records without wrap-time metadata are migrated conservatively and remain protected. The persisted state schema version is advanced for the added metadata. Unit coverage crosses the retention boundary while the wrap remains queryable, then advances the checkpoint and verifies eventual pruning.

## Shutdown-safe inbox discovery and publication

Inbox relay discovery now uses an abortable subscription instead of the non-abortable one-shot pool query. Lifecycle checks fence discovery completion, message construction, relay selection, and each publication. Shutdown aborts an outstanding lookup before destroying the pool.

A routed local WebSocket regression begins discovery, returns an inbox event while withholding EOSE, closes the bus, and confirms that the pending send is rejected without opening or publishing to the newly discovered relay after close returns.

## Validation and remaining boundary

Validation against Node 24 and the locked dependency tree:

- 39 tests pass across eleven files.
- TypeScript validation and the diff whitespace check pass.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

The exact immutable commit identity is reported after publication.

Gateway supervisor ownership, global lifecycle restrictions, coordinated path activation, failed-start rollback, and live observation remain separate private deployment work. No repository document authorizes a merge, deployment, service change, or restart.
