import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaimedIdTracker } from "./claimed-id-tracker.js";

afterEach(() => vi.useRealTimers());

describe("claimed ID tracker", () => {
  it("separates concurrent claims from completed IDs", () => {
    const tracker = createClaimedIdTracker({ pruneIntervalMs: 60_000 });

    expect(tracker.claim("rumor-one")).toBe("claimed");
    expect(tracker.claim("rumor-one")).toBe("inflight");
    tracker.complete("rumor-one");
    expect(tracker.claim("rumor-one")).toBe("processed");

    tracker.stop();
  });

  it("allows a failed claim to be retried and honors persisted seeds", () => {
    const tracker = createClaimedIdTracker({ pruneIntervalMs: 60_000 });

    expect(tracker.claim("retryable-rumor")).toBe("claimed");
    tracker.release("retryable-rumor");
    expect(tracker.claim("retryable-rumor")).toBe("claimed");
    tracker.release("retryable-rumor");

    tracker.seed(["persisted-rumor"]);
    expect(tracker.claim("persisted-rumor")).toBe("processed");

    tracker.stop();
  });

  it("retains completed IDs across fast-cache expiry, capacity eviction, and restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const options = {
      maxEntries: 1,
      ttlMs: 60 * 60 * 1000,
      retentionMs: 2 * 24 * 60 * 60 * 1000,
      pruneIntervalMs: 60_000,
    };
    const tracker = createClaimedIdTracker(options);

    expect(tracker.claim("first")).toBe("claimed");
    tracker.complete("first");
    expect(tracker.claim("second")).toBe("claimed");
    tracker.complete("second");

    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(tracker.claim("first")).toBe("processed");

    const persisted = tracker.snapshotPersisted();
    tracker.stop();
    const restarted = createClaimedIdTracker(options);
    restarted.seedPersisted(persisted);
    expect(restarted.claim("first")).toBe("processed");

    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000 + 1);
    expect(restarted.claim("first")).toBe("claimed");
    restarted.release("first");
    restarted.stop();
  });

  it("extends retention when a later duplicate is observed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const retentionMs = 2 * 24 * 60 * 60 * 1000;
    const tracker = createClaimedIdTracker({
      maxEntries: 1,
      ttlMs: 60 * 60 * 1000,
      retentionMs,
      pruneIntervalMs: 60_000,
    });

    expect(tracker.claim("rumor")).toBe("claimed");
    tracker.complete("rumor");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(tracker.claim("rumor")).toBe("processed");

    const persisted = tracker.snapshotPersisted();
    tracker.stop();
    const restarted = createClaimedIdTracker({
      maxEntries: 1,
      ttlMs: 60 * 60 * 1000,
      retentionMs,
      pruneIntervalMs: 60_000,
    });
    restarted.seedPersisted(persisted);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(restarted.claim("rumor")).toBe("processed");

    vi.advanceTimersByTime(retentionMs + 1);
    expect(restarted.claim("rumor")).toBe("claimed");
    restarted.release("rumor");
    restarted.stop();
  });

  it("retains IDs while their wrap timestamp remains inside the durable query window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const retentionMs = 2 * 24 * 60 * 60 * 1000;
    let protectedSince = 1_799_800_000;
    const tracker = createClaimedIdTracker({
      maxEntries: 1,
      ttlMs: retentionMs,
      retentionMs,
      protectedSince: () => protectedSince,
    });

    expect(tracker.claim("long-lived", 1_799_900_000)).toBe("claimed");
    tracker.complete("long-lived", 1_799_900_000);
    vi.advanceTimersByTime(retentionMs + 11 * 60 * 1000);
    expect(tracker.claim("long-lived", 1_799_900_000)).toBe("processed");

    protectedSince = 1_799_900_001;
    vi.advanceTimersByTime(retentionMs + 1);
    expect(tracker.claim("long-lived", 1_799_900_000)).toBe("claimed");
    tracker.release("long-lived");
    tracker.stop();
  });
});
