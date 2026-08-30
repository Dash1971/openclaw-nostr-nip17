import { describe, expect, it } from "vitest";
import { parseRelayUrls } from "./setup-adapter.js";

describe("relay URL validation", () => {
  it("accepts secure public relay syntax", () => {
    expect(parseRelayUrls("wss://relay.example, wss://relay2.example/path")).toEqual({
      relays: ["wss://relay.example", "wss://relay2.example/path"],
    });
  });

  it.each([
    "ws://relay.example",
    "https://relay.example",
    "wss://user:password@relay.example",
    "wss://relay.example/#fragment",
    "wss://127.0.0.1",
    "wss://localhost",
  ])("rejects unsafe relay URL %s", (relay) => {
    expect(parseRelayUrls(relay).error).toBeTruthy();
  });
});
