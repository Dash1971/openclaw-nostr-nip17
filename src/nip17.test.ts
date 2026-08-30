import { generateSecretKey, getPublicKey } from "nostr-tools";
import { wrapEvent } from "nostr-tools/nip17";
import { describe, expect, it } from "vitest";
import {
  createNip17Message,
  NIP17_INBOX_RELAYS_KIND,
  readInboxRelays,
  unwrapNip17Message,
} from "./nip17.js";

describe("NIP-17 transport", () => {
  it("round-trips a private message and exposes the authenticated sender", () => {
    const senderKey = generateSecretKey();
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const event = createNip17Message(senderKey, recipientPubkey, "secret test");

    const message = unwrapNip17Message(event, recipientKey, recipientPubkey);

    expect(message.senderPubkey).toBe(getPublicKey(senderKey));
    expect(message.content).toBe("secret test");
    expect(message.rumorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a gift wrap addressed to another recipient", () => {
    const senderKey = generateSecretKey();
    const intendedRecipient = generateSecretKey();
    const wrongRecipient = generateSecretKey();
    const event = wrapEvent(
      senderKey,
      { publicKey: getPublicKey(intendedRecipient) },
      "not for you",
    );

    expect(() =>
      unwrapNip17Message(event, wrongRecipient, getPublicKey(wrongRecipient)),
    ).toThrow();
  });

  it("reads and sanitizes NIP-17 inbox relays", () => {
    const event = {
      kind: NIP17_INBOX_RELAYS_KIND,
      tags: [
        ["relay", "wss://inbox.example"],
        ["relay", "wss://inbox.example"],
        ["relay", "https://not-a-relay.example"],
      ],
    } as never;

    expect(readInboxRelays(event)).toEqual(["wss://inbox.example"]);
  });
});
