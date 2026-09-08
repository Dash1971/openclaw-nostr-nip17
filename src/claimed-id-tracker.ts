import { createSeenTracker } from "./seen-tracker.js";

export type IdClaimResult = "claimed" | "processed" | "inflight";

export function createClaimedIdTracker(options?: {
  maxEntries?: number;
  ttlMs?: number;
  pruneIntervalMs?: number;
}) {
  const processed = createSeenTracker(options);
  const inflight = new Set<string>();

  return {
    claim(id: string): IdClaimResult {
      if (processed.peek(id)) {
        return "processed";
      }
      if (inflight.has(id)) {
        return "inflight";
      }
      inflight.add(id);
      return "claimed";
    },
    complete(id: string): void {
      inflight.delete(id);
      processed.add(id);
    },
    release(id: string): void {
      inflight.delete(id);
    },
    seed(ids: Iterable<string>): void {
      processed.seed([...ids]);
    },
    size(): number {
      return processed.size();
    },
    stop(): void {
      inflight.clear();
      processed.stop();
    },
  };
}
