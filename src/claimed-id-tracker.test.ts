import { describe, expect, it } from "vitest";
import { createClaimedIdTracker } from "./claimed-id-tracker.js";

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
});
