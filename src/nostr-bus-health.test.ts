import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateSubscriptionHealth, computeReplaySinceTimestamp } from "./nostr-bus.js";
import { buildNostrListenerStatus } from "./gateway.js";
import type { SubscriptionHealth } from "./subscription-supervisor.js";

const health = (state: SubscriptionHealth["state"], overrides: Partial<SubscriptionHealth> = {}) => ({
  state,
  generation: 1,
  reconnectAttempts: 0,
  nextReconnectAt: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastEventAt: null,
  lastEoseAt: null,
  lastError: null,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("aggregate Nostr bus health", () => {
  it("keeps reconnect overlap bounded after a long idle period", () => {
    const nowSec = 1_800_000_000;
    const twoDaysAndFiveMinutes = 2 * 24 * 60 * 60 + 300;

    expect(computeReplaySinceTimestamp(nowSec - 30 * 24 * 60 * 60, nowSec)).toBe(
      nowSec - twoDaysAndFiveMinutes,
    );
    expect(computeReplaySinceTimestamp(nowSec + 60, nowSec)).toBe(
      nowSec + 60 - twoDaysAndFiveMinutes,
    );
  });

  it("reports degraded with partial relay coverage and unhealthy with none", () => {
    const relays = ["wss://one", "wss://two", "wss://three"];
    const states = new Map<string, SubscriptionHealth>([
      [relays[0]!, health("healthy", { lastConnectedAt: 10 })],
      [relays[1]!, health("degraded", { reconnectAttempts: 2, lastError: "closed" })],
      [relays[2]!, health("degraded", { reconnectAttempts: 1, lastError: "timeout" })],
    ]);
    expect(aggregateSubscriptionHealth(relays, states)).toMatchObject({
      state: "degraded",
      connectedRelays: 1,
      totalRelays: 3,
      reconnectAttempts: 3,
    });
    states.set(relays[0]!, health("degraded", { lastError: "failed" }));
    expect(aggregateSubscriptionHealth(relays, states)).toMatchObject({
      state: "unhealthy",
      connectedRelays: 0,
    });
  });

  it("keeps partial relay coverage connected without fabricating transport heartbeat activity", () => {
    const status = buildNostrListenerStatus(
      { lastTransportActivityAt: 5 },
      { accountId: "default", publicKey: "public-key" },
      {
        state: "degraded",
        connectedRelays: 1,
        totalRelays: 3,
        reconnectAttempts: 2,
        lastConnectedAt: 10,
        lastDisconnectedAt: 11,
        lastEventAt: null,
        lastEoseAt: 10,
        lastError: "two relays unavailable",
        relays: {},
      },
    );

    expect(status).toMatchObject({
      running: true,
      connected: true,
      statusState: "degraded",
      healthState: "degraded",
      lastTransportActivityAt: null,
    });
  });

  it("does not reuse old message activity after the host stale threshold or a fresh reconnect", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const oldMessageAt = Date.now();
    vi.advanceTimersByTime(31 * 60 * 1000);

    const status = buildNostrListenerStatus(
      { lastTransportActivityAt: oldMessageAt },
      { accountId: "default", publicKey: "public-key" },
      {
        state: "healthy",
        connectedRelays: 1,
        totalRelays: 1,
        reconnectAttempts: 0,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: Date.now() - 1,
        lastEventAt: oldMessageAt,
        lastEoseAt: Date.now(),
        lastError: null,
        relays: {},
      },
    );

    expect(status).toMatchObject({
      connected: true,
      healthState: "healthy",
      lastConnectedAt: Date.now(),
      lastTransportActivityAt: null,
    });
  });
});
