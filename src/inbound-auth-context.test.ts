import { describe, expect, it } from "vitest";
import { buildNostrInboundAuthContext } from "./inbound-auth-context.js";

describe("Nostr inbound authentication context", () => {
  it("marks a TOTP-gated dispatch as verified", () => {
    const context = buildNostrInboundAuthContext({
      totpConfigured: true,
      senderPubkey: "abc123",
    });

    expect(context.bodyPrefix).toContain("plugin-generated");
    expect(context.bodyPrefix).toContain("TOTP authentication all passed");
    expect(context.extraContext).toEqual({
      NostrAuthentication: {
        verified: true,
        method: "nip17+allowlist+totp",
        senderPubkey: "abc123",
      },
    });
  });

  it("fails closed when TOTP is not configured", () => {
    const context = buildNostrInboundAuthContext({
      totpConfigured: false,
      senderPubkey: "abc123",
    });

    expect(context.bodyPrefix).toContain("unverified");
    expect(context.extraContext).toMatchObject({
      NostrAuthentication: { verified: false },
    });
  });
});
