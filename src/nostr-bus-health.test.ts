import { describe, expect, it } from "vitest";
import { aggregateSubscriptionHealth } from "./nostr-bus.js";
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

describe("aggregate Nostr bus health", () => {
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
});
