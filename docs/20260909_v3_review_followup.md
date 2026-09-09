# Reconnect hardening fourth review follow-up

Status: implementation candidate ready for independent re-review. This document does not approve merge or deployment. Reviewers should pin the exact PR head commit after publication.

## Review addressed

This revision responds to the independent re-review of commit `df0a05472cc5ce1586787816225188c545682e7d`. The review identified two remaining recovery interleavings: one relay's earlier handler snapshot could advance the shared checkpoint while another relay's pre-EOSE handler remained pending, and cancellation during an already-started WebSocket handshake could be reported as successful while its socket escaped pool cleanup. Both are addressed with real bus and transport regressions.

## Generation-scoped multi-relay catch-up

Each relay subscription generation now owns an explicit catch-up record containing its candidate checkpoint, positively observed EOSE state, and the set of handler operations started before that EOSE. The common checkpoint advances to the earliest participating candidate only when every configured relay is healthy in the matching generation, every generation has genuine EOSE, every corresponding pre-EOSE operation has completed, and no retryable event remains.

Completion of any participating operation re-evaluates the whole multi-relay certification rather than relying on a per-relay snapshot captured at EOSE. Generation changes invalidate the old certification.

The regression interleaves two local relays: relay A reaches EOSE with one blocked handler, relay B later reaches EOSE with another blocked handler, and A completes while B remains pending. It verifies that the checkpoint does not move, then bounds shutdown while B is abandoned, verifies the checkpoint still does not move, and confirms B is redelivered to a replacement lifecycle.

## Cancellation-safe connection ownership

Shutdown now aborts discovery, connection, and publication work immediately when close begins, while application handlers retain their existing bounded drain for state completion. Publication rechecks cancellation after the dependency promise settles and rejects the dependency's fulfilled `connection failure:` result rather than treating it as relay acceptance.

The bus now owns a tracked WebSocket implementation backed by the production `ws` dependency. Every socket created for the lifecycle is tracked independently of the pool's relay map. Final cleanup forcibly terminates connecting as well as open sockets, including a relay that the dependency removed from its map after connection rejection.

The transport regression completes inbox discovery, holds the recipient relay's HTTP upgrade so the client remains in `CONNECTING`, and begins shutdown using the default drain contract. It verifies that the send rejects, the client leaves both `CONNECTING` and `OPEN`, a subsequently released upgrade cannot leave a live recipient connection, and no gift wrap is published.

## Validation and remaining boundary

Validation against Node 24 and the locked dependency tree:

- 41 tests pass across eleven files.
- TypeScript validation and the diff whitespace check pass.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

The exact immutable commit identity is reported after publication.

Gateway supervisor ownership, global lifecycle restrictions, coordinated path activation, failed-start rollback, and live observation remain separate private deployment work. No repository document authorizes a merge, deployment, service change, or restart.
