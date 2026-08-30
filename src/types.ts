// Nostr type declarations define plugin contracts.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import {
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInputString, type SecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate } from "./nostr-key-utils.js";

interface NostrAccountConfig {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  privateKey?: SecretInput;
  privateKeyFile?: string;
  totpSecret?: SecretInput;
  totpSecretFile?: string;
  totpSessionSeconds?: number;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: NostrProfile;
}

function readProtectedSecretFile(path: string | undefined): string | undefined {
  const normalized = path?.trim();
  if (!normalized) return undefined;
  if (!isAbsolute(normalized)) throw new Error("Nostr secret file path must be absolute");
  const stat = lstatSync(normalized);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Nostr secret path must be a regular non-symlink file: ${normalized}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Nostr secret file must not be accessible by group or others: ${normalized}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Nostr secret file must be owned by the OpenClaw user: ${normalized}`);
  }
  const value = readFileSync(normalized, "utf8").trim();
  if (!value) throw new Error(`Nostr secret file is empty: ${normalized}`);
  return value;
}

export interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  totpSecret: string;
  totpSessionSeconds: number;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}

function resolveConfiguredDefaultNostrAccountId(cfg: OpenClawConfig): string | undefined {
  const nostrCfg = (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;
  return normalizeOptionalAccountId(nostrCfg?.defaultAccount);
}

/**
 * List all configured Nostr account IDs
 */
export function listNostrAccountIds(cfg: OpenClawConfig): string[] {
  const nostrCfg = (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;
  const privateKey =
    normalizeSecretInputString(nostrCfg?.privateKey) ??
    readProtectedSecretFile(nostrCfg?.privateKeyFile) ??
    process.env.NOSTR_PRIVATE_KEY?.trim();
  return listCombinedAccountIds({
    configuredAccountIds: [],
    implicitAccountId: privateKey
      ? (resolveConfiguredDefaultNostrAccountId(cfg) ?? DEFAULT_ACCOUNT_ID)
      : undefined,
  });
}

/**
 * Get the default account ID
 */
export function resolveDefaultNostrAccountId(cfg: OpenClawConfig): string {
  return resolveListedDefaultAccountId({
    accountIds: listNostrAccountIds(cfg),
    configuredDefaultAccountId: resolveConfiguredDefaultNostrAccountId(cfg),
  });
}

/**
 * Resolve a Nostr account from config
 */
export function resolveNostrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultNostrAccountId(opts.cfg));
  const nostrCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;

  const baseEnabled = nostrCfg?.enabled !== false;
  const privateKey =
    normalizeSecretInputString(nostrCfg?.privateKey) ??
    readProtectedSecretFile(nostrCfg?.privateKeyFile) ??
    process.env.NOSTR_PRIVATE_KEY?.trim() ??
    "";
  let configured = false;

  let publicKey = "";
  if (privateKey) {
    try {
      publicKey = getPublicKeyFromPrivate(privateKey);
      configured = true;
    } catch {
      // Invalid key - leave publicKey empty, configured will indicate issues
    }
  }

  return {
    accountId,
    name: normalizeOptionalString(nostrCfg?.name),
    enabled: baseEnabled,
    configured,
    privateKey,
    totpSecret:
      normalizeSecretInputString(nostrCfg?.totpSecret) ??
      readProtectedSecretFile(nostrCfg?.totpSecretFile) ??
      process.env.NOSTR_TOTP_SECRET?.trim() ??
      "",
    totpSessionSeconds: nostrCfg?.totpSessionSeconds ?? 300,
    publicKey,
    relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
    profile: nostrCfg?.profile,
    config: {
      enabled: nostrCfg?.enabled,
      name: nostrCfg?.name,
      privateKey: nostrCfg?.privateKey,
      privateKeyFile: nostrCfg?.privateKeyFile,
      totpSecret: nostrCfg?.totpSecret,
      totpSecretFile: nostrCfg?.totpSecretFile,
      totpSessionSeconds: nostrCfg?.totpSessionSeconds,
      relays: nostrCfg?.relays,
      dmPolicy: nostrCfg?.dmPolicy,
      allowFrom: nostrCfg?.allowFrom,
      profile: nostrCfg?.profile,
    },
  };
}
