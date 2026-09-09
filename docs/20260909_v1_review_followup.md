# Reconnect hardening second review follow-up

Status: reviewed at commit `9ab569aad883e455c6c54092a4a3b4fd741464df`; changes were requested. The response is documented in [the third review follow-up](20260909_v2_review_followup.md). This document does not approve merge or deployment.

## Review addressed

This revision responds to the independent re-review of commit `683f66e38223e116b95bbdb1a1e5007a6d17d5fa`. The review identified two P1 recovery defects and two P2 replay/persistence defects. All four are addressed in the current candidate with regression coverage.

## Outage-safe catch-up boundary

The subscription query is now anchored to a durable `caughtUpAt` checkpoint rather than advancing from wall clock. The checkpoint advances only after every configured relay's current subscription generation has reached EOSE and the handlers queued before that EOSE have settled. A disconnect or process outage therefore preserves the last completed catch-up boundary plus the full NIP-59 backdating overlap.

Regression coverage restores a pre-outage checkpoint, supplies valid backdated gift wraps that the rejected wall-clock boundary would omit, delivers them out of timestamp order, and verifies both dispatch and checkpoint advancement.

## Bounded shutdown and lifecycle fence

Shutdown stops subscriptions and permits a graceful drain for at most four seconds by default, below the pinned host's five-second channel-stop deadline. It then closes the lifecycle fence, aborts supported relay publications, flushes completed state, and destroys the complete relay pool.

An arbitrary external callback cannot be forcibly terminated in JavaScript. If it remains unresolved beyond the drain deadline, it is abandoned: later completion cannot mark the message processed, persist plugin state, or initiate a reply through the closed lifecycle. The message remains eligible for a replacement lifecycle. A regression test holds a callback indefinitely, verifies bounded close and socket cleanup, starts a replacement bus that successfully handles the same message, and then releases the old callback without duplicate state effects.

## Replay horizon extension

A verified later gift wrap for an already-processed rumor now refreshes that rumor's durable retention timestamp. Protection therefore lasts through the latest accepted wrap's complete replay horizon, not merely the first dispatch time. Tests cross the original durable expiry, force fast-cache eviction, persist the refreshed timestamp, restart, and confirm continued suppression.

## Bounded persistence under continuous traffic

State persistence is now a bounded leading timer: the first dirty event schedules a write and later events cannot reset that deadline. The default maximum dirty interval is five seconds. Events arriving while a write is in progress schedule the next bounded flush as needed.

This limits, but cannot eliminate, the crash replay window. A process failure may replay externally completed work not yet included in the most recent write, with a residual window of up to five seconds plus filesystem durability behavior. The implementation does not claim exactly-once external effects across abrupt process failure.

Integration coverage sends messages more frequently than the configured test flush interval, reads the state while the original bus is still running, restores only that disk snapshot into a second lifecycle, and confirms that the first persisted rumor is not dispatched again. No graceful-close flush is used to create that snapshot.

## Validation and remaining boundary

Validation against Node 24 and the locked dependency tree:

- 34 tests pass across ten files.
- TypeScript validation and the diff whitespace check pass.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

The exact immutable commit identity is reported after publication.

Gateway supervisor ownership, global lifecycle restrictions, coordinated path activation, failed-start rollback, and live observation remain separate private deployment work. No repository document authorizes a merge, deployment, service change, or restart.
