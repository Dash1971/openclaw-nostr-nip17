// Nostr plugin module implements nostr state store behavior.
import { getNostrRuntime } from "./runtime.js";
import { normalizeNostrStateAccountId } from "./state-account-id.js";
import { readTextFileIfExists, writeJsonFileSecure } from "openclaw/plugin-sdk/security-runtime";
import path from "node:path";
import type { PersistedClaimedId } from "./claimed-id-tracker.js";

const STORE_VERSION = 6;
const PROFILE_STATE_VERSION = 1;

type NostrBusState = {
  version: 2 | 3 | 4 | 5 | 6;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
  /** Latest wall-clock point through which relay catch-up completed */
  caughtUpAt?: number | null;
  /** Recent processed event IDs for overlap dedupe across restarts */
  recentEventIds: string[];
  /** Recent authenticated rumor IDs for dedupe across gift wraps and restarts */
  recentRumorIds?: string[];
  /** Timestamped authenticated rumor IDs retained for the complete subscription overlap */
  processedRumorIds?: PersistedClaimedId[];
};

/** Profile publish state (separate from bus state) */
type NostrProfileState = {
  version: 1;
  /** Unix timestamp (seconds) of last successful profile publish */
  lastPublishedAt: number | null;
  /** Event ID of the last published profile */
  lastPublishedEventId: string | null;
  /** Per-relay publish results from last attempt */
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

function resolveStorePath(namespace: string, accountId: string, env?: NodeJS.ProcessEnv): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env);
  return path.join(stateDir, "plugins", "nostr", namespace, `${accountId}.json`);
}

function readStateFile<T>(namespace: string, accountId: string, env?: NodeJS.ProcessEnv): T | null {
  const raw = readTextFileIfExists(resolveStorePath(namespace, accountId, env));
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStateFile<T>(
  namespace: string,
  accountId: string,
  payload: T,
  env?: NodeJS.ProcessEnv,
): void {
  writeJsonFileSecure(resolveStorePath(namespace, accountId, env), payload);
}

export async function readNostrBusState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrBusState | null> {
  return readStateFile<NostrBusState>(
    "bus-state",
    normalizeNostrStateAccountId(params.accountId),
    params.env,
  );
}

export async function writeNostrBusState(params: {
  accountId?: string;
  lastProcessedAt: number;
  gatewayStartedAt: number;
  caughtUpAt?: number;
  recentEventIds?: string[];
  recentRumorIds?: string[];
  processedRumorIds?: PersistedClaimedId[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrBusState = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    caughtUpAt: params.caughtUpAt ?? null,
    recentEventIds: (params.recentEventIds ?? []).filter((x): x is string => typeof x === "string"),
    recentRumorIds: (params.recentRumorIds ?? []).filter(
      (x): x is string => typeof x === "string",
    ),
    processedRumorIds: (params.processedRumorIds ?? []).filter(
      (entry): entry is PersistedClaimedId =>
        typeof entry?.id === "string" &&
        Boolean(entry.id) &&
        typeof entry.processedAt === "number" &&
        Number.isFinite(entry.processedAt) &&
        (entry.latestEventCreatedAt === undefined ||
          (typeof entry.latestEventCreatedAt === "number" &&
            Number.isFinite(entry.latestEventCreatedAt))),
    ),
  };
  writeStateFile(
    "bus-state",
    normalizeNostrStateAccountId(params.accountId),
    payload,
    params.env,
  );
}

/**
 * Determine the `since` timestamp for subscription.
 * Returns the later of: lastProcessedAt or gatewayStartedAt (both from state),
 * falling back to `now` for fresh starts.
 */
export function computeSinceTimestamp(
  state: NostrBusState | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!state) {
    return nowSec;
  }

  // Use the most recent timestamp we have
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t): t is number => t !== null && t > 0,
  );

  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}

// ============================================================================
// Profile State Management
// ============================================================================

export async function readNostrProfileState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrProfileState | null> {
  return readStateFile<NostrProfileState>(
    "profile-state",
    normalizeNostrStateAccountId(params.accountId),
    params.env,
  );
}

export async function writeNostrProfileState(params: {
  accountId?: string;
  lastPublishedAt: number;
  lastPublishedEventId: string;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrProfileState = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults,
  };
  writeStateFile(
    "profile-state",
    normalizeNostrStateAccountId(params.accountId),
    payload,
    params.env,
  );
}
