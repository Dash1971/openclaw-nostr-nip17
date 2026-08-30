import { describe, expect, it } from "vitest";
import { createTotpAuthenticator } from "./totp-auth.js";

const RFC_6238_SHA1_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Nostr TOTP authentication", () => {
  it("consumes unauthenticated messages before dispatch", () => {
    const auth = createTotpAuthenticator({ secret: RFC_6238_SHA1_SECRET, now: () => 59_000 });
    expect(auth.authenticate("sender", "do something").decision).toBe("consume");
  });

  it("accepts an RFC 6238 code and opens a bounded session", () => {
    let nowMs = 59_000;
    const auth = createTotpAuthenticator({
      secret: RFC_6238_SHA1_SECRET,
      sessionSeconds: 60,
      now: () => nowMs,
    });
    expect(auth.authenticate("sender", "AUTH 287082")).toEqual({
      decision: "consume",
      reply: "Authenticated for 1 minute.",
    });
    expect(auth.authenticate("sender", "normal command")).toEqual({ decision: "allow" });
    expect(auth.authenticate("sender", "AUTH 287082")).toEqual({
      decision: "consume",
      reply: "Already authenticated.",
    });
    nowMs += 61_000;
    expect(auth.authenticate("sender", "normal command").decision).toBe("consume");
  });

  it("does not reuse a successful time-step code", () => {
    let nowMs = 59_000;
    const auth = createTotpAuthenticator({
      secret: RFC_6238_SHA1_SECRET,
      sessionSeconds: 60,
      now: () => nowMs,
    });
    auth.authenticate("sender", "AUTH 287082");
    nowMs += 61_000;
    expect(auth.authenticate("sender", "AUTH 287082")).toEqual({
      decision: "consume",
      reply: "Authentication failed.",
    });
  });

  it("locks temporarily after five failed codes", () => {
    const auth = createTotpAuthenticator({ secret: RFC_6238_SHA1_SECRET, now: () => 59_000 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      auth.authenticate("sender", "AUTH 000000");
    }
    expect(auth.authenticate("sender", "AUTH 287082")).toEqual({
      decision: "consume",
      reply: "Authentication temporarily locked. Try again later.",
    });
  });
});
