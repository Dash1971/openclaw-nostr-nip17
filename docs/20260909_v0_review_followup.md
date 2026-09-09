# Reconnect hardening review follow-up

Status: implementation candidate ready for independent re-review. This document does not approve merge or deployment. Reviewers should pin the exact PR head commit rather than relying on a moving branch name.

## Scope

This follow-up addresses the plugin-code findings in [the independent review](20260909_independent_review.md). Gateway lifecycle policy and atomic activation remain separate private deployment work and are not implemented by this repository.

## Implemented corrections

- Listener status no longer reports message, EOSE, or connection timestamps as transport heartbeat activity. Because the transport library does not expose ping/pong timestamps, the host receives a null transport-activity value and the plugin's explicit connected and health states remain authoritative.
- Replacement subscriptions compute a bounded query boundary from current time while retaining the latest processed timestamp as protection against a backward local-clock adjustment. They no longer retain the startup query indefinitely.
- Verified rumor IDs have timestamped durable retention covering the complete NIP-59 query overlap. The small LRU/TTL tracker remains a fast cache, but its capacity or expiry no longer removes the durable replay decision.
- Legacy persisted rumor IDs are migrated conservatively on read; new state writes use timestamped records.
- Only the invocation that acquired an outer-event in-flight claim may release it.
- Shutdown stops subscription supervisors, rejects new work, waits for active inbound and outbound operations, flushes state, and destroys the complete relay pool, including connections opened for recipient-advertised inbox relays.
- Gateway stop waits for the asynchronous bus shutdown before returning.
- Installation guidance now uses the manifest plugin ID.

## Regression evidence

The candidate adds deterministic tests for:

1. healthy idle status beyond the host's 30-minute stale threshold;
2. a fresh reconnect after older message activity;
3. replay after fast-cache capacity eviction and expiry;
4. identical gift-wrap and distinct-wrap/same-rumor replay through the complete bus handler;
5. replay after persisted-state restart;
6. shutdown while an inbound handler is active, including relay connection closure.

The existing controlled two-relay test continues to verify that one failed relay reconnects without recycling the healthy relay.

Validation against Node 24 and the locked dependency tree:

- 32 tests pass across ten files.
- TypeScript validation passes.
- The diff whitespace check passes.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

## Deliberately unresolved here

- The external service-repair environment policy is not represented as a global lifecycle guard.
- Supervisor ownership, lifecycle entry-point restrictions, atomic path activation, failed-start rollback, and action-scoped readiness evidence require a concrete private operator implementation and review.
- The live observation window exceeding both prior thresholds is an acceptance step after code review and before deployment approval; deterministic tests do not replace it.

## Requested review

1. Confirm that null transport activity is compatible with the pinned host health policy while explicit connection and health fields remain populated.
2. Verify that durable rumor retention covers every event returned by the subscription overlap, including eviction and restart cases.
3. Inspect close ordering for operations that start immediately before shutdown.
4. Confirm that pool destruction covers both configured and dynamically discovered relay connections.
5. Treat the eventual immutable PR head as the implementation identity; do not infer approval from this document.
