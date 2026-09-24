import type { NostrBusHandle } from "./nostr-bus.js";
import type { MetricsSnapshot } from "./metrics.js";

type NostrBusRegistry = {
  activeBuses: Map<string, NostrBusHandle>;
  metricsSnapshots: Map<string, MetricsSnapshot>;
};

// Gateway and outbound adapters may be loaded through separate module caches.
// Both must resolve the same account bus within this gateway process.
const key = Symbol.for("@dash1971/openclaw-nostr-nip17/bus-registry/v1");
const shared = globalThis as typeof globalThis & { [key]?: NostrBusRegistry };

export function getNostrBusRegistry(): NostrBusRegistry {
  return (shared[key] ??= { activeBuses: new Map(), metricsSnapshots: new Map() });
}
