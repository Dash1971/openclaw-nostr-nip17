# Reconnect hardening sixth review follow-up

Status: implementation candidate ready for independent re-review. This document does not approve merge or deployment. Reviewers should pin the exact PR head commit after publication.

## Review addressed

This revision responds to the independent re-review of commit `8c4569b413766180ee8243cda7581765bd491f22`. The review confirmed the retired-generation barrier for pre-EOSE backlog handlers but identified the corresponding live-delivery gap: handlers started after EOSE were excluded from the generation's pending set and therefore could not be transferred into the retired-generation barrier on reconnect.

After a reconnect beyond the five-minute overlap allowance, a replacement generation could observe the same wrap as an in-flight duplicate, reach genuine EOSE, and advance the durable checkpoint before the original live handler's outcome was known. A later failure could then lose its retry.

## Complete inbound-delivery ownership

Every inbound operation associated with the current relay subscription generation now enters that generation's pending set, regardless of whether it begins before or after EOSE. EOSE continues to certify relay backlog transmission; it no longer limits which active deliveries participate in checkpoint safety.

When a generation is replaced, all unfinished inbound operations transfer into the retired-generation checkpoint barrier. The replacement generation cannot advance the common checkpoint until those operations reach their actual outcome:

- Successful completion removes the obligation and permits current-generation progress.
- Transient failure records retryable state before releasing the obligation, retaining the earlier durable boundary.
- Bounded shutdown retains the earlier boundary when a handler is abandoned; the existing lifecycle fence prevents late state mutation.

Completed post-EOSE operations impose no lasting cost: they leave the generation's pending set when they settle, and re-evaluating the already-certified candidate is idempotent.

## Regression matrix

The real local WebSocket relay matrix now covers delivery both before and after EOSE. For post-EOSE coverage, the relay:

1. Sends genuine EOSE for the initial subscription.
2. Sends a valid live gift wrap whose randomized timestamp remains inside the current replay boundary.
3. Holds the message handler and advances the controlled clock by six minutes, crossing the five-minute allowance.
4. Sends `CLOSED`, allows the normal supervisor reconnect, replays the wrap, and sends genuine EOSE.

Three post-EOSE outcomes are verified:

- Success keeps the checkpoint fixed while pending, then permits advancement after durable delivery completion.
- Transient failure retains the certified pre-reconnect boundary and redelivers successfully in a replacement lifecycle.
- Bounded-shutdown abandonment returns within the configured deadline, retains the boundary, and redelivers successfully in a replacement lifecycle.

Together with the preceding revision's three pre-EOSE tests, this provides the requested six-case ownership matrix.

## Validation and remaining boundary

Validation against Node 24 and the locked dependency tree:

- 47 tests pass across eleven files.
- TypeScript validation and the diff whitespace check pass.
- The production dependency audit reports zero vulnerabilities.
- The candidate public-content scan found no credentials, private keys, local filesystem paths, private-network addresses, or personal commit email addresses. Protocol examples and public project identity remain intentionally public.

The exact immutable commit identity is reported after publication.

Gateway supervisor ownership, global lifecycle restrictions, coordinated path activation, failed-start rollback, and live observation remain separate private deployment work. No repository document authorizes a merge, deployment, service change, or restart.
