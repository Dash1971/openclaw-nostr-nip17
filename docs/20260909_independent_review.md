# Independent review: reconnect hardening and deployment design

Status: changes requested. This review does not approve merge or deployment.

Reviewed implementation: 73e6b200839e2e3f59daf6482cf9cfcca660275f.
Host compatibility target for source-based checks: OpenClaw v2026.7.1-2.
Review findings refer to the implementation source tree; identifiers have been updated after documentation history cleanup.

## Confirmed improvements

- Partial relay coverage now stays connected while retaining degraded health. A source-based check passes this snapshot through the host health policy successfully.
- Verified rumor-ID claims add a second deduplication boundary and persisted startup seeds.
- A controlled two-endpoint WebSocket test verifies one failed relay reconnects without recycling the healthy relay.
- The deployment design recognizes the need for one service owner and explicit, bounded recovery.

## P1: idle liveness still triggers unnecessary channel restarts

The listener status maps lastTransportActivityAt to message/EOSE timestamps. It does not report actual ping/pong activity. A healthy idle connection becomes stale under the reviewed host policy after 30 minutes.

The null-coalescing expression also chooses an old lastEventAt ahead of a newer lastEoseAt or lastConnectedAt. A source-based check reproduced a fresh reconnect still being classified as stale.

Required:
- Use actual transport liveness or host-supported semantics for a provider without transport heartbeat reporting.
- Do not fabricate liveness through an unconditional timer.
- Test idle time beyond the stale threshold and a fresh reconnect following old message traffic.

Sources: [status mapping](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/src/gateway.ts#L34-L64), [host health policy](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/gateway/channel-health-policy.ts).

## P1: replay retention remains shorter than the reconnect query window

Both processed event IDs and processed rumor IDs use the same one-hour TTL. Replacement subscriptions reuse the original multi-day since filter. Persisted rumor IDs are seeded at startup, not consulted on every claim.

A completed rumor became claimable again after advancing a test clock by 61 minutes. Persistence alone therefore does not close this gap. Capacity is also relevant: persisted lists are bounded to 5,000 IDs.

Required:
- Define dedupe retention consistently with query overlap, cache eviction, restart, and persistence boundaries.
- Test late replay of both identical gift wraps and distinct wraps of the same verified rumor through the bus handler.
- Preserve the overlap needed for valid backdated NIP-59 events.

Sources: [tracker configuration](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/src/nostr-bus.ts#L484-L532), [claim tracker](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/src/claimed-id-tracker.ts), [subscription filter](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/src/nostr-bus.ts#L814-L827).

## P1: external repair policy is not a global lifecycle guard

The host's doctor service-repair policy checks OPENCLAW_SERVICE_REPAIR_POLICY. Its separate triggerOpenClawRestart function does not enforce that policy: it performs stale-process cleanup and follows its platform-specific service targeting.

A local test ran this function with a synthetic environment, the external policy enabled, and mocked OS effects. Cleanup and a user-domain lifecycle command were still attempted. No real service action was executed.

Required:
- Inventory doctor, direct lifecycle CLI, update, internal restart, and config-reload paths.
- Define which are blocked or redirected for externally supervised deployments.
- Verify actual environment inheritance by launcher rather than assuming one shell setting covers all execution contexts.
- Review and test the concrete guard/helper implementation before deployment.

Sources: [doctor policy](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/commands/doctor-service-repair-policy.ts), [restart implementation](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/infra/restart.ts).

## P1: live checkout replacement requires a coordinated activation design

The plugin has runtime dynamic imports and a lazy entry loader. Replacing the active checkout can allow newly loaded modules to come from a different tree than already loaded modules. Treating every source-file change as inert until restart is unsupported.

Required:
- Build and test outside the active plugin directory.
- Define the file/path switch together with process activation, config-watcher behavior, and active-work handling.
- Validate rollback when startup fails and no healthy gateway listener exists.
- Serialize lifecycle mutations and use numeric readiness deadlines with action-scoped log evidence.

Sources: [runtime import](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/src/gateway.ts#L220), [entry loader](https://github.com/Dash1971/openclaw-nostr-nip17/blob/73e6b200839e2e3f59daf6482cf9cfcca660275f/index.ts).

## Additional corrections

- The outer-event handler still unconditionally deletes an in-flight entry in finally, including when that invocation did not acquire it. The new rumor claim mitigates ordinary duplicate dispatch, but ownership should still be corrected and tested through the complete handler.
- Shutdown does not await already-started handlers, and only configured relays are passed to pool.close even though publication can use discovered recipient relays. Add full bus startup/stop/in-flight tests.
- The README still refers to enabling nostr-nip17 while the manifest declares plugin ID nostr. Correct the identity/installation guidance as part of a separately tested change.
- A 30-minute soak does not cross the actual stale-health and one-hour cache thresholds. Use deterministic boundary tests and an observation period exceeding both.
- Pin the implementation separately from documentation revisions; a moving branch tip is not an immutable deployment identity.
- The new WebSocket test exercises supervisors. It does not establish complete bus persistence, host-health, or shutdown correctness.

## Validation performed

Focused local checks confirmed:
- partial relay coverage remains connected and passes host health evaluation;
- idle staleness and old-timestamp precedence still fail;
- a processed rumor becomes claimable after 61 minutes;
- external repair policy does not prevent the separate restart helper's behavior when OS effects are mocked.

The implementation author reports 27 passing tests and a passing typecheck. The reviewer inspected the added tests but did not independently rerun the full suite. These findings are source-based and isolated; they do not assert any particular deployment's current state.

## Requested follow-up

Fix the code findings with targeted regression tests and update the public design requirements. Keep concrete operator runbooks and machine-specific evidence private. Request a new review against the resulting immutable implementation commit before considering deployment.
