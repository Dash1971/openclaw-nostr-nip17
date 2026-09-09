# Gateway lifecycle and Nostr recovery: public design requirements

Status: design under review. This document is generic deployment guidance, not an operator runbook or authorization to change a running service. See [the independent review](20260909_independent_review.md) for unresolved findings.

## Review references

- Implementation reviewed: 73e6b200839e2e3f59daf6482cf9cfcca660275f.
- Baseline implementation: 061325a8f0a36e85fcdd4214c2529503299a0946.
- Branch: fix/reconnect-hardening.
- Compatibility target used for source-based review: OpenClaw v2026.7.1-2.

Documentation-only commits may follow the implementation. Deployment review must identify the exact source and dependency tree, not assume the branch tip still equals an earlier implementation commit.

## Separate transport recovery from service ownership

A channel should recover failed relay subscriptions independently. A disconnected relay should not require restarting the whole gateway, and surviving subscriptions should remain usable.

A gateway should have one deliberate supervisor. Its lifecycle commands must address the same supervisor that owns the running process. This principle applies across service managers and platforms; the actual service identity and operator procedure belong in a private deployment runbook.

## Requirements before deployment

1. Fix and test the outstanding idle-health and replay-retention defects in the independent review.
2. Inventory lifecycle entry points, including service repair, direct start/restart/install, updates, internal restart requests, and configuration reload. Establish which are permitted and how they reach the intended supervisor.
3. Do not treat OPENCLAW_SERVICE_REPAIR_POLICY=external as a global restart guard. The reviewed host implementation applies it to doctor service repair; other restart paths require separate handling.
4. Verify environment inheritance for each actual launcher. Editing a persistent environment source does not update a process that is already running.
5. Stage the candidate and dependencies outside the active plugin directory. Define the exact activation switch, including lazy imports, configuration watchers, and active-work handling.
6. Review the concrete lifecycle helper and its permission boundary privately before using it. Requirements alone do not constitute implementation approval.

## Generic lifecycle helper contract

- Status is read-only and identifies the actual supervisor, process, logical listener ownership, RPC readiness, and channel readiness.
- Healthy-deployment validation and failed-start recovery validation are separate. An approved recovery must not require the failed gateway to be healthy.
- Concurrent mutations are serialized, and ownership is rechecked immediately before an action.
- A lifecycle action performs only the explicitly requested operation against the intended supervisor. No speculative force-kill, bootstrap, installation, repeated restart, or reboot fallback is allowed.
- Readiness has a numeric timeout and evaluates only observations and log entries from the current action.
- Multiple sockets belonging to one process, such as IPv4 and IPv6 listeners, are not mistaken for multiple gateways.
- Failure preserves evidence and stops for the defined recovery procedure.

## Candidate preparation and activation

- Pin an exact reviewed commit and dependency lockfile.
- Run the complete test suite, typecheck, diff check, dependency review, and public-content check in an isolated working directory.
- Preserve the known rollback source and compatible state handling.
- Keep the active plugin directory unchanged until the coordinated activation step.
- Define how active work and state writes are handled before process replacement.
- After the authorized activation, verify the intended supervisor, one gateway owner, RPC, and independently configured channel health.
- Do not claim an interruption duration until the actual deployment procedure has been measured.

## Acceptance evidence

The candidate should demonstrate:

1. NIP-17 authentication and message round trips using synthetic test identities.
2. One dispatch for concurrent duplicates and for distinct gift wraps containing the same verified rumor.
3. Replay protection beyond cache expiration, capacity eviction, and restart boundaries.
4. Reply publication to eligible recipient inbox relays with accurate per-operation success/failure evidence.
5. Recovery of one failed relay while healthy relays remain active.
6. Total listener-loss reporting and bounded retry.
7. Idle transport health beyond the host's stale threshold.
8. Clean shutdown during startup, reconnect, and an in-flight handler.
9. Deterministic tests beyond the 30-minute health and one-hour dedupe thresholds, plus a deliberately designed observation window exceeding both. A 75–90-minute window is a starting point, not a substitute for those tests.

Use controlled local relays for fault injection. If any end-to-end scenario is not exercised, state that limitation instead of treating supervisor-only tests as complete gateway validation.

## Rollback requirements

Rollback must work when the gateway is unavailable. Verify the intended supervisor, approved rollback files, and absence of a foreign listener before acting. Preserve useful failure evidence. Do not restore conflicting service ownership as part of a plugin rollback, and do not repeatedly restart a failing candidate.

## Public/private boundary

Public discussion should contain code, synthetic reproductions, versioned compatibility findings, and generic lifecycle requirements. Keep host identities, access details, filesystem layouts, actual service definitions, privileged command configuration, credentials, logs, incident timelines, and operator approvals outside the public repository.
