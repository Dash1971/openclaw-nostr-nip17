// Nostr helper module supports config schema behavior.
import {
  AllowFromListSchema,
  DmPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-primitives";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";

/**
 * Validates https:// URLs only (no javascript:, data:, file:, etc.)
 */
const safeUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use https:// protocol" },
  );

export const RelayUrlSchema = z.string().max(2048).refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "wss:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        Boolean(url.hostname) &&
        !isBlockedHostnameOrIp(url.hostname.trim().toLowerCase())
      );
    } catch {
      return false;
    }
  },
  { message: "Relay must be a credential-free wss:// URL without a fragment" },
);

/**
 * NIP-01 profile metadata schema
 * https://github.com/nostr-protocol/nips/blob/master/01.md
 */
export const NostrProfileSchema = z.object({
  /** Username (NIP-01: name) - max 256 chars */
  name: z.string().max(256).optional(),

  /** Display name (NIP-01: display_name) - max 256 chars */
  displayName: z.string().max(256).optional(),

  /** Bio/description (NIP-01: about) - max 2000 chars */
  about: z.string().max(2000).optional(),

  /** Profile picture URL (must be https) */
  picture: safeUrlSchema.optional(),

  /** Banner image URL (must be https) */
  banner: safeUrlSchema.optional(),

  /** Website URL (must be https) */
  website: safeUrlSchema.optional(),

  /** NIP-05 identifier (e.g., "user@example.com") */
  nip05: z.string().optional(),

  /** Lightning address (LUD-16) */
  lud16: z.string().optional(),
});

export interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}

/**
 * Zod schema for channels.nostr.* configuration
 */
export const NostrConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Optional default account id for routing/account selection. */
  defaultAccount: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema,

  /** Private key in hex or nsec bech32 format */
  privateKey: buildSecretInputSchema().optional(),

  /** Owner-only local file containing the private key. */
  privateKeyFile: z.string().min(1).optional(),

  /** Optional second-factor seed. When set, inbound DMs require TOTP authentication. */
  totpSecret: buildSecretInputSchema().optional(),

  /** Owner-only local file containing the TOTP seed. */
  totpSecretFile: z.string().min(1).optional(),

  /** Duration of an authenticated Nostr session. */
  totpSessionSeconds: z.number().int().min(60).max(3600).default(300),

  /** WebSocket relay URLs to connect to */
  relays: z.array(RelayUrlSchema).min(1).max(10).optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: DmPolicySchema.optional(),

  /** Allowed sender pubkeys (npub or hex format) */
  allowFrom: AllowFromListSchema,

  /** Profile metadata (NIP-01 kind:0 content) */
  profile: NostrProfileSchema.optional(),
});
