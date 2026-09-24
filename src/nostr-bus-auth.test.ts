import {
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { createNip17Message } from "./nip17.js";
import { publishEventToAllRelays, publishEventWithNip42Auth } from "./nostr-bus.js";

describe("NIP-42 relay authentication", () => {
  it("signs a relay challenge when an inbox relay requires authentication", async () => {
    const senderKey = generateSecretKey();
    const recipientKey = generateSecretKey();
    const message = createNip17Message(
      senderKey,
      getPublicKey(recipientKey),
      "authenticated relay test",
    );
    const publish = vi.fn(
      (
        _relays: string[],
        _event: Event,
        params?: { onauth?: (event: EventTemplate) => Promise<VerifiedEvent> },
      ) => {
        if (!params?.onauth) {
          return [Promise.reject(new Error("missing NIP-42 auth signer"))];
        }
        const challenge: EventTemplate = {
          kind: 22242,
          created_at: 1_788_849_600,
          content: "",
          tags: [
            ["relay", "wss://auth.example"],
            ["challenge", "challenge-value"],
          ],
        };
        return [
          params.onauth(challenge).then((authEvent) => {
            expect(authEvent.kind).toBe(22242);
            expect(authEvent.pubkey).toBe(getPublicKey(senderKey));
            expect(verifyEvent(authEvent)).toBe(true);
            return "auth accepted";
          }),
        ];
      },
    );

    await publishEventWithNip42Auth({ publish }, "wss://auth.example", message, senderKey);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toEqual(["wss://auth.example"]);
    expect(publish.mock.calls[0]?.[2]?.onauth).toBeTypeOf("function");
  });

  it("replicates a reply to every advertised inbox relay", async () => {
    const senderKey = generateSecretKey();
    const recipientKey = generateSecretKey();
    const message = createNip17Message(senderKey, getPublicKey(recipientKey), "replicated reply");
    const publish = vi.fn((relays: string[]) => [
      relays[0] === "wss://two.example"
        ? Promise.reject(new Error("relay unavailable"))
        : Promise.resolve("accepted"),
    ]);

    const results = await publishEventToAllRelays(
      { publish },
      ["wss://one.example", "wss://two.example", "wss://three.example"],
      message,
      senderKey,
    );

    expect(publish.mock.calls.map((call) => call[0])).toEqual([
      ["wss://one.example"],
      ["wss://two.example"],
      ["wss://three.example"],
    ]);
    expect(results.filter((result) => !result.error)).toHaveLength(2);
    expect(results.find((result) => result.relay === "wss://two.example")?.error?.message).toBe(
      "relay unavailable",
    );
  });
});
