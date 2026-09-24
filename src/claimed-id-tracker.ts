import { createSeenTracker } from "./seen-tracker.js";

export type IdClaimResult = "claimed" | "processed" | "inflight";

export type PersistedClaimedId = {
  id: string;
  processedAt: number;
  latestEventCreatedAt?: number;
};

export function createClaimedIdTracker(options?: {
  maxEntries?: number;
  ttlMs?: number;
  retentionMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  protectedSince?: () => number;
}) {
  const processed = createSeenTracker(options);
  const inflight = new Set<string>();
  const retained = new Map<string, Omit<PersistedClaimedId, "id">>();
  const retentionMs = Math.max(
    1,
    Math.floor(options?.retentionMs ?? options?.ttlMs ?? 60 * 60 * 1000),
  );
  const now = options?.now ?? Date.now;
  const protectedSince = options?.protectedSince;

  const pruneRetained = () => {
    const cutoff = now() - retentionMs;
    const querySince = protectedSince?.();
    for (const [id, entry] of retained) {
      const stillQueryable =
        querySince !== undefined &&
        entry.latestEventCreatedAt !== undefined &&
        entry.latestEventCreatedAt >= querySince;
      if (entry.processedAt < cutoff && !stillQueryable) retained.delete(id);
    }
  };

  const retain = (id: string, eventCreatedAt?: number) => {
    const existing = retained.get(id);
    retained.set(id, {
      processedAt: now(),
      latestEventCreatedAt:
        eventCreatedAt === undefined
          ? existing?.latestEventCreatedAt
          : Math.max(existing?.latestEventCreatedAt ?? 0, eventCreatedAt),
    });
  };

  return {
    claim(id: string, eventCreatedAt?: number): IdClaimResult {
      pruneRetained();
      if (retained.has(id)) {
        retain(id, eventCreatedAt);
        return "processed";
      }
      if (processed.peek(id)) {
        retain(id, eventCreatedAt);
        return "processed";
      }
      if (inflight.has(id)) {
        return "inflight";
      }
      inflight.add(id);
      return "claimed";
    },
    complete(id: string, eventCreatedAt?: number): void {
      inflight.delete(id);
      processed.add(id);
      retain(id, eventCreatedAt);
    },
    release(id: string): void {
      inflight.delete(id);
    },
    seed(ids: Iterable<string>): void {
      const seeded = [...ids];
      processed.seed(seeded);
      const processedAt = now();
      for (const id of seeded) {
        retained.set(id, {
          processedAt,
          latestEventCreatedAt: Number.MAX_SAFE_INTEGER,
        });
      }
    },
    seedPersisted(entries: Iterable<PersistedClaimedId>): void {
      const cutoff = now() - retentionMs;
      const seeded: string[] = [];
      for (const entry of entries) {
        const latestEventCreatedAt =
          typeof entry.latestEventCreatedAt === "number" &&
          Number.isFinite(entry.latestEventCreatedAt)
            ? entry.latestEventCreatedAt
            : Number.MAX_SAFE_INTEGER;
        const querySince = protectedSince?.();
        const stillQueryable = querySince !== undefined && latestEventCreatedAt >= querySince;
        if (
          typeof entry?.id !== "string" ||
          !entry.id ||
          !Number.isFinite(entry.processedAt) ||
          (entry.processedAt < cutoff && !stillQueryable)
        ) {
          continue;
        }
        const existing = retained.get(entry.id);
        retained.set(entry.id, {
          processedAt: Math.max(existing?.processedAt ?? 0, entry.processedAt),
          latestEventCreatedAt: Math.max(
            existing?.latestEventCreatedAt ?? 0,
            latestEventCreatedAt,
          ),
        });
        seeded.push(entry.id);
      }
      processed.seed(seeded);
    },
    snapshotPersisted(): PersistedClaimedId[] {
      pruneRetained();
      return [...retained].map(([id, entry]) => ({ id, ...entry }));
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
