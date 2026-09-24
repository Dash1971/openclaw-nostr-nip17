import { afterEach, describe, expect, it, vi } from "vitest";
import { getNostrBusRegistry } from "./bus-registry.js";
import type { NostrBusHandle } from "./nostr-bus.js";

afterEach(() => {
  getNostrBusRegistry().activeBuses.clear();
  getNostrBusRegistry().metricsSnapshots.clear();
});

describe("shared Nostr outbound runtime", () => {
  it("retains the gateway bus across independently loaded adapter modules", async () => {
    const pubkey = "58".repeat(32);
    const sendDm = vi.fn(async () => {});
    const registry = getNostrBusRegistry();
    registry.activeBuses.set("fixture", { sendDm } as unknown as NostrBusHandle);
    vi.resetModules();
    const reloaded = await import("./bus-registry.js");
    expect(reloaded.getNostrBusRegistry()).toBe(registry);
    const { setNostrRuntime } = await import("./runtime.js");
    setNostrRuntime({ channel: { text: {
      resolveMarkdownTableMode: () => "off",
      convertMarkdownTables: (text: string) => text,
    } } } as unknown as Parameters<typeof setNostrRuntime>[0]);
    const { nostrOutboundAdapter } = await import("./gateway.js");
    await nostrOutboundAdapter.sendText({
      cfg: {}, to: `nostr:${pubkey}`, text: "fixture reply", accountId: "fixture",
    });
    expect(sendDm).toHaveBeenCalledExactlyOnceWith(pubkey, "fixture reply");
    await expect(nostrOutboundAdapter.sendText({
      cfg: {}, to: pubkey, text: "fixture reply", accountId: "different-account",
    })).rejects.toThrow("Nostr bus not running for account different-account");
    registry.activeBuses.delete("fixture");
    expect(reloaded.getNostrBusRegistry().activeBuses.has("fixture")).toBe(false);
  });
});
