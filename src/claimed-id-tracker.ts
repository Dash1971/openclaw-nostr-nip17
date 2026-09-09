import { createSeenTracker } from "./seen-tracker.js";

export type IdClaimResult = "claimed" | "processed" | "inflight";

export type PersistedClaimedId = {
  id: string;
  processedAt: number;
};

export function createClaimedIdTracker(options?: {
  maxEntries?: number;
  ttlMs?: number;
  retentionMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
}) {
  const processed = createSeenTracker(options);
  const inflight = new Set<string>();
  const retained = new Map<string, number>();
  const retentionMs = Math.max(
    1,
    Math.floor(options?.retentionMs ?? options?.ttlMs ?? 60 * 60 * 1000),
  );
  const now = options?.now ?? Date.now;

  const pruneRetained = () => {
    const cutoff = now() - retentionMs;
    for (const [id, processedAt] of retained) {
      if (processedAt < cutoff) retained.delete(id);
    }
  };

  return {
    claim(id: string): IdClaimResult {
      pruneRetained();
      if (retained.has(id)) {
        retained.set(id, now());
        return "processed";
      }
      if (processed.peek(id)) {
        retained.set(id, now());
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
      retained.set(id, now());
    },
    release(id: string): void {
      inflight.delete(id);
    },
    seed(ids: Iterable<string>): void {
      const seeded = [...ids];
      processed.seed(seeded);
      const processedAt = now();
      for (const id of seeded) retained.set(id, processedAt);
    },
    seedPersisted(entries: Iterable<PersistedClaimedId>): void {
      const cutoff = now() - retentionMs;
      const seeded: string[] = [];
      for (const entry of entries) {
        if (
          typeof entry?.id !== "string" ||
          !entry.id ||
          !Number.isFinite(entry.processedAt) ||
          entry.processedAt < cutoff
        ) {
          continue;
        }
        const existing = retained.get(entry.id);
        retained.set(entry.id, Math.max(existing ?? 0, entry.processedAt));
        seeded.push(entry.id);
      }
      processed.seed(seeded);
    },
    snapshotPersisted(): PersistedClaimedId[] {
      pruneRetained();
      return [...retained].map(([id, processedAt]) => ({ id, processedAt }));
    },
    size(): number {
      pruneRetained();
      return retained.size;
    },
    stop(): void {
      inflight.clear();
      retained.clear();
      processed.stop();
    },
  };
}
