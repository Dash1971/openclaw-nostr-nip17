# Reconnect hardening fifth review follow-up

Status: implementation candidate ready for independent re-review. This document does not approve merge or deployment. Reviewers should pin the exact PR head commit after publication.

## Review addressed

This revision responds to the independent re-review of commit `f46467f594ae065052a0aced010730e3ac8714ea`. The review identified one remaining checkpoint race: replacing a relay subscription generation removed the retired generation's catch-up record even when a message handler started by that generation was still unfinished. A replay in the replacement generation could then return through the in-flight duplicate path, reach genuine EOSE, and advance the durable checkpoint before the original delivery outcome was known.

## Retired-generation delivery ownership

Transport certification still belongs only to the current healthy subscription generation. When a generation is replaced, however, every unfinished pre-EOSE handler operation from the retired generation is transferred into a separate checkpoint-obligation barrier. The common checkpoint cannot advance while that barrier is non-empty.

Each obligation remains until its actual handler operation settles:

- Successful completion removes the obligation, after which current generations may certify progress normally.
- A transient failure records the event as retryable before the obligation is removed, preserving the earlier checkpoint for redelivery.
- Bounded shutdown cannot advance the checkpoint while an abandoned operation remains outstanding; late completion is fenced by the existing lifecycle boundary.

The replacement generation's duplicate observation remains useful for dispatch deduplication, but it is not treated as proof that the original delivery succeeded.

## Regression coverage

Three real local WebSocket relay tests force a subscription `CLOSED`, allow the normal supervisor reconnect, replay the same gift wrap in the replacement generation, and send genuine EOSE:

1. The original handler completes successfully: the checkpoint remains unchanged while it is pending, then advances after delivery is recorded.
2. The original handler fails transiently: the checkpoint remains unchanged and a replacement bus lifecycle redelivers the message successfully.
3. Shutdown reaches its bounded drain while the original handler remains blocked: close returns within the bound, the checkpoint remains unchanged, and the next lifecycle redelivers the message.

These tests exercise the production bus, subscription supervisor, NIP-17 unwrap/dedupe path, state store, and locked WebSocket transport.

## Validation and remaining boundary

Validation against Node 24 and the locked dependency tree:

- 44 tests pass across eleven files.
- TypeScript validation and the diff whitespace check pass.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

The exact immutable commit identity is reported after publication.

Gateway supervisor ownership, global lifecycle restrictions, coordinated path activation, failed-start rollback, and live observation remain separate private deployment work. No repository document authorizes a merge, deployment, service change, or restart.
