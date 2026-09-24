import { describe, expect, it } from "vitest";
import { normalizePubkey, pubkeyToNpub } from "./nostr-key-utils.js";
import { nostrPlugin } from "./channel.js";

describe("Nostr reply targets", () => {
  const hex = "58".repeat(32);
  const npub = pubkeyToNpub(hex);
  it.each([hex, hex.toUpperCase(), npub, `nostr:${hex}`, `nostr:${npub}`, ` NOSTR:${hex} `])(
    "recognizes and normalizes %s", (target) => {
      expect(normalizePubkey(target)).toBe(hex);
      expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.(target)).toBe(true);
    },
  );
  it.each(["nostr:invalid", "npub1invalid", "nostr:" + "58".repeat(31), "nostr:nostr:" + hex])(
    "rejects malformed target %s", (target) => {
      expect(() => normalizePubkey(target)).toThrow();
      expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.(target)).toBe(false);
    },
  );
});
