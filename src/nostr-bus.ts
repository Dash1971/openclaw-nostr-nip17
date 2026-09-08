// Nostr plugin module implements nostr bus behavior.
import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";
import {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "openclaw/plugin-sdk/direct-dm-guard-policy";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import {
  createMetrics,
  createNoopMetrics,
  type NostrMetrics,
  type MetricsSnapshot,
  type MetricEvent,
} from "./metrics.js";
import { validatePrivateKey } from "./nostr-key-utils.js";
import { publishProfile as publishProfileFn, type ProfilePublishResult } from "./nostr-profile.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { createSeenTracker, type SeenTracker } from "./seen-tracker.js";
import {
  createSubscriptionSupervisor,
  type SubscriptionHealth,
} from "./subscription-supervisor.js";
import {
  createNip17Message,
  NIP17_GIFT_WRAP_KIND,
  NIP17_INBOX_RELAYS_KIND,
  readInboxRelays,
  unwrapNip17Message,
} from "./nip17.js";

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 2 * 24 * 60 * 60 + 300; // NIP-59 timestamps are randomized up to 2 days
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000; // Debounce state writes
const DEFAULT_INBOUND_GUARD_POLICY = createDirectDmPreCryptoGuardPolicy();

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before half-open

// Health tracker configuration
const HEALTH_WINDOW_MS = 60000; // 1 minute window for health stats

export interface NostrBusHealth {
  state: "connecting" | "healthy" | "degraded" | "unhealthy" | "stopped";
  connectedRelays: number;
  totalRelays: number;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastEventAt: number | null;
  lastEoseAt: number | null;
  lastError: string | null;
  relays: Record<string, SubscriptionHealth>;
}

export function aggregateSubscriptionHealth(
  relays: string[],
  relayHealth: ReadonlyMap<string, SubscriptionHealth>,
): NostrBusHealth {
  const states = relays.map((relay) => relayHealth.get(relay)).filter(Boolean) as SubscriptionHealth[];
  const connectedRelays = states.filter((health) => health.state === "healthy").length;
  const stoppedRelays = states.filter((health) => health.state === "stopped").length;
  const state: NostrBusHealth["state"] =
    stoppedRelays === relays.length
      ? "stopped"
      : connectedRelays === relays.length
        ? "healthy"
        : connectedRelays > 0
          ? "degraded"
          : states.some((health) => health.state === "degraded")
            ? "unhealthy"
            : "connecting";
  const latest = (field: keyof SubscriptionHealth): number | null => {
    const values = states
      .map((health) => health[field])
      .filter((value): value is number => typeof value === "number");
    return values.length ? Math.max(...values) : null;
  };
  return {
    state,
    connectedRelays,
    totalRelays: relays.length,
    reconnectAttempts: states.reduce((sum, health) => sum + health.reconnectAttempts, 0),
    lastConnectedAt: latest("lastConnectedAt"),
    lastDisconnectedAt: latest("lastDisconnectedAt"),
    lastEventAt: latest("lastEventAt"),
    lastEoseAt: latest("lastEoseAt"),
    lastError:
      states
        .map((health) => health.lastError)
        .filter((error): error is string => Boolean(error))
        .join("; ") || null,
    relays: Object.fromEntries(
      relays.flatMap((relay) => {
        const health = relayHealth.get(relay);
        return health ? [[relay, { ...health }]] : [];
      }),
    ),
  };
}

type RelayPublisher = {
  publish: (
    relays: string[],
    event: Event,
    params?: {
      onauth?: (event: EventTemplate) => Promise<VerifiedEvent>;
    },
  ) => Promise<string>[];
};

export async function publishEventWithNip42Auth(
  pool: RelayPublisher,
  relay: string,
  event: Event,
  sk: Uint8Array,
): Promise<void> {
  const publishPromises = pool.publish([relay], event, {
    onauth: async (authEvent) => finalizeEvent(authEvent, sk),
  });
  if (publishPromises.length === 0) {
    throw new Error(`Failed to create publish promise for relay ${relay}`);
  }
  await publishPromises[0];
}

export async function publishEventToAllRelays(
  pool: RelayPublisher,
  relays: string[],
  event: Event,
  sk: Uint8Array,
): Promise<Array<{ relay: string; durationMs: number; error?: Error }>> {
  return await Promise.all(
    relays.map(async (relay) => {
      const startedAt = Date.now();
      try {
        await publishEventWithNip42Auth(pool, relay, event, sk);
        return { relay, durationMs: Date.now() - startedAt };
      } catch (error) {
        return {
          relay,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }),
  );
}

// ============================================================================
// Types
// ============================================================================

interface NostrBusOptions {
  /** Private key in hex or nsec format */
  privateKey: string;
  /** WebSocket relay URLs (defaults to damus + nos.lol) */
  relays?: string[];
  /** Account ID for state persistence (optional, defaults to pubkey prefix) */
  accountId?: string;
  /** Called when a DM is received */
  onMessage: (
    pubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
    meta: { eventId: string; createdAt: number },
  ) => Promise<void>;
  /** Called after signature verification and before decrypt to allow sender policy checks (optional) */
  authorizeSender?: (params: {
    senderPubkey: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<"allow" | "block" | "pairing">;
  /** Override pre-crypto DM guardrails for tests or future channel tuning (optional) */
  guardPolicy?: DirectDmPreCryptoGuardPolicyOverrides;
  /** Called on errors (optional) */
  onError?: (error: Error, context: string) => void;
  /** Called on connection status changes (optional) */
  onConnect?: (relay: string) => void;
  /** Called on disconnection (optional) */
  onDisconnect?: (relay: string) => void;
  /** Called on EOSE (end of stored events) for initial sync (optional) */
  onEose?: (relay: string) => void;
  /** Called on each metric event (optional) */
  onMetric?: (event: MetricEvent) => void;
  /** Called whenever listener health changes (optional) */
  onHealth?: (health: NostrBusHealth) => void;
  /** Maximum entries in seen tracker (default: 100,000) */
  maxSeenEntries?: number;
  /** Seen tracker TTL in ms (default: 1 hour) */
  seenTtlMs?: number;
}

type FixedWindowRateLimiter = {
  isRateLimited: (key: string, nowMs?: number) => boolean;
  size: () => number;
  clear: () => void;
};

function createFixedWindowRateLimiter(params: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
}): FixedWindowRateLimiter {
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const maxRequests = Math.max(1, Math.floor(params.maxRequests));
  const maxTrackedKeys = Math.max(1, Math.floor(params.maxTrackedKeys));
  const state = new Map<string, { count: number; windowStartMs: number }>();

  const touch = (key: string, value: { count: number; windowStartMs: number }) => {
    state.delete(key);
    state.set(key, value);
  };

  const prune = (nowMs: number) => {
    for (const [key, entry] of state) {
      if (nowMs - entry.windowStartMs >= windowMs) {
        state.delete(key);
      }
    }
    while (state.size > maxTrackedKeys) {
      const oldest = state.keys().next().value;
      if (!oldest) {
        break;
      }
      state.delete(oldest);
    }
  };

  return {
    isRateLimited: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return false;
      }
      prune(nowMs);
      const existing = state.get(key);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        touch(key, { count: 1, windowStartMs: nowMs });
        return false;
      }
      const nextCount = existing.count + 1;
      touch(key, { count: nextCount, windowStartMs: existing.windowStartMs });
      return nextCount > maxRequests;
    },
    size: () => state.size,
    clear: () => state.clear(),
  };
}

export interface NostrBusHandle {
  /** Stop the bus and close relay connections */
  close: () => void;
  /** Get the bot's public key */
  publicKey: string;
  /** Send a DM to a pubkey */
  sendDm: (toPubkey: string, text: string) => Promise<void>;
  /** Get current metrics snapshot */
  getMetrics: () => MetricsSnapshot;
  /** Get the current listener health */
  getHealth: () => NostrBusHealth;
  /** Publish a profile (kind:0) to all relays */
  publishProfile: (profile: NostrProfile) => Promise<ProfilePublishResult>;
  /** Get the last profile publish state */
  getProfileState: () => Promise<{
    lastPublishedAt: number | null;
    lastPublishedEventId: string | null;
    lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
  }>;
}

// ============================================================================
// Circuit Breaker
// ============================================================================

interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failures: number;
  lastFailure: number;
  lastSuccess: number;
}

interface CircuitBreaker {
  /** Check if requests should be allowed */
  canAttempt: () => boolean;
  /** Record a success */
  recordSuccess: () => void;
  /** Record a failure */
  recordFailure: () => void;
  /** Get current state */
  getState: () => CircuitBreakerState["state"];
}

function createCircuitBreaker(
  relay: string,
  metrics: NostrMetrics,
  threshold: number = CIRCUIT_BREAKER_THRESHOLD,
  resetMs: number = CIRCUIT_BREAKER_RESET_MS,
): CircuitBreaker {
  const state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
  };

  return {
    canAttempt(): boolean {
      if (state.state === "closed") {
        return true;
      }

      if (state.state === "open") {
        // Check if enough time has passed to try half-open
        if (Date.now() - state.lastFailure >= resetMs) {
          state.state = "half_open";
          metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
          return true;
        }
        return false;
      }

      // half_open: allow one attempt
      return true;
    },

    recordSuccess(): void {
      if (state.state === "half_open") {
        state.state = "closed";
        state.failures = 0;
        metrics.emit("relay.circuit_breaker.close", 1, { relay });
      } else if (state.state === "closed") {
        state.failures = 0;
      }
      state.lastSuccess = Date.now();
    },

    recordFailure(): void {
      state.failures++;
      state.lastFailure = Date.now();

      if (state.state === "half_open") {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      } else if (state.state === "closed" && state.failures >= threshold) {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      }
    },

    getState(): CircuitBreakerState["state"] {
      return state.state;
    },
  };
}

// ============================================================================
// Relay Health Tracker
// ============================================================================

interface RelayHealthStats {
  successCount: number;
  failureCount: number;
  latencySum: number;
  latencyCount: number;
  lastSuccess: number;
  lastFailure: number;
}

interface RelayHealthTracker {
  /** Record a successful operation */
  recordSuccess: (relay: string, latencyMs: number) => void;
  /** Record a failed operation */
  recordFailure: (relay: string) => void;
  /** Get health score (0-1, higher is better) */
  getScore: (relay: string) => number;
  /** Get relays sorted by health (best first) */
  getSortedRelays: (relays: string[]) => string[];
}

function createRelayHealthTracker(): RelayHealthTracker {
  const stats = new Map<string, RelayHealthStats>();

  function getOrCreate(relay: string): RelayHealthStats {
    let s = stats.get(relay);
    if (!s) {
      s = {
        successCount: 0,
        failureCount: 0,
        latencySum: 0,
        latencyCount: 0,
        lastSuccess: 0,
        lastFailure: 0,
      };
      stats.set(relay, s);
    }
    return s;
  }

  return {
    recordSuccess(relay: string, latencyMs: number): void {
      const s = getOrCreate(relay);
      s.successCount++;
      s.latencySum += latencyMs;
      s.latencyCount++;
      s.lastSuccess = Date.now();
    },

    recordFailure(relay: string): void {
      const s = getOrCreate(relay);
      s.failureCount++;
      s.lastFailure = Date.now();
    },

    getScore(relay: string): number {
      const s = stats.get(relay);
      if (!s) {
        return 0.5;
      } // Unknown relay gets neutral score

      const total = s.successCount + s.failureCount;
      if (total === 0) {
        return 0.5;
      }

      // Success rate (0-1)
      const successRate = s.successCount / total;

      // Recency bonus (prefer recently successful relays)
      const now = Date.now();
      const recencyBonus =
        s.lastSuccess > s.lastFailure
          ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2
          : 0;

      // Latency penalty (lower is better)
      const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1000;
      const latencyPenalty = Math.min(0.2, avgLatency / 10000);

      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },

    getSortedRelays(relays: string[]): string[] {
      return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
    },
  };
}

// ============================================================================
// Main Bus
// ============================================================================

/**
 * Start the Nostr DM bus - subscribes to NIP-17 gift-wrapped private DMs
 */
export async function startNostrBus(options: NostrBusOptions): Promise<NostrBusHandle> {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    authorizeSender,
    onError,
    onEose,
    onMetric,
    maxSeenEntries = 100_000,
    seenTtlMs = 60 * 60 * 1000,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool({ enablePing: true, enableReconnect: false });
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);
  const guardPolicy = createDirectDmPreCryptoGuardPolicy({
    ...DEFAULT_INBOUND_GUARD_POLICY,
    ...options.guardPolicy,
    rateLimit: {
      ...DEFAULT_INBOUND_GUARD_POLICY.rateLimit,
      ...options.guardPolicy?.rateLimit,
    },
  });

  // Initialize metrics
  const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();

  // Initialize seen tracker with LRU
  const seen: SeenTracker = createSeenTracker({
    maxEntries: maxSeenEntries,
    ttlMs: seenTtlMs,
  });

  // Initialize circuit breakers and health tracker
  const circuitBreakers = new Map<string, CircuitBreaker>();
  const healthTracker = createRelayHealthTracker();

  for (const relay of relays) {
    circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
  }

  // Read persisted state and compute `since` timestamp (with small overlap)
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  // Seed in-memory dedupe with recent IDs from disk (prevents restart replay)
  if (state?.recentEventIds?.length) {
    seen.seed(state.recentEventIds);
  }

  // Persist startup timestamp
  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
  });

  // Debounced state persistence
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) {
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    }

    if (pendingWrite) {
      clearTimeout(pendingWrite);
    }
    pendingWrite = setTimeout(() => {
      writeNostrBusState({
        accountId,
        lastProcessedAt,
        gatewayStartedAt,
        recentEventIds,
      }).catch((err: unknown) => onError?.(err as Error, "persist state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  const inflight = new Set<string>();
  const perSenderRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxPerSenderPerWindow,
    maxTrackedKeys: guardPolicy.rateLimit.maxTrackedSenderKeys,
  });
  const globalRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxGlobalPerWindow,
    maxTrackedKeys: 1,
  });

  const updateRateLimiterSizeMetric = () => {
    metrics.emit(
      "memory.rate_limiter_entries",
      perSenderRateLimiter.size() + globalRateLimiter.size(),
    );
  };

  // Event handler
  async function handleEvent(event: Event): Promise<void> {
    try {
      metrics.emit("event.received");

      // Fast dedupe check (handles relay reconnections)
      if (seen.peek(event.id) || inflight.has(event.id)) {
        metrics.emit("event.duplicate");
        return;
      }
      inflight.add(event.id);

      const markSeen = () => {
        seen.add(event.id);
        metrics.emit("memory.seen_tracker_size", seen.size());
      };
      const rejectAndMarkSeen = (metric: Parameters<typeof metrics.emit>[0]) => {
        markSeen();
        metrics.emit(metric);
      };
      const rejectVerifiedAndPersist = (metric: Parameters<typeof metrics.emit>[0]) => {
        rejectAndMarkSeen(metric);
        scheduleStatePersist(event.created_at, event.id);
      };

      // Skip events older than our `since` (relay may ignore filter)
      if (event.created_at < since) {
        rejectAndMarkSeen("event.rejected.stale");
        return;
      }

      if (event.created_at > Math.floor(Date.now() / 1000) + guardPolicy.maxFutureSkewSec) {
        metrics.emit("event.rejected.future");
        return;
      }

      if (event.kind !== NIP17_GIFT_WRAP_KIND) {
        rejectAndMarkSeen("event.rejected.wrong_kind");
        return;
      }

      // Fast p-tag check BEFORE crypto (no allocation, cheaper)
      let targetsUs = false;
      for (const t of event.tags) {
        if (t[0] === "p" && t[1] === pk) {
          targetsUs = true;
          break;
        }
      }
      if (!targetsUs) {
        rejectAndMarkSeen("event.rejected.wrong_kind");
        return;
      }

      const rejectIfGlobalRateLimited = (): boolean => {
        updateRateLimiterSizeMetric();
        if (globalRateLimiter.isRateLimited("global")) {
          metrics.emit("rate_limit.global");
          metrics.emit("event.rejected.rate_limited");
          updateRateLimiterSizeMetric();
          return true;
        }
        updateRateLimiterSizeMetric();
        return false;
      };

      const rejectIfVerifiedSenderRateLimited = (senderPubkey: string): boolean => {
        updateRateLimiterSizeMetric();
        if (perSenderRateLimiter.isRateLimited(senderPubkey)) {
          metrics.emit("rate_limit.per_sender");
          metrics.emit("event.rejected.rate_limited");
          updateRateLimiterSizeMetric();
          return true;
        }
        updateRateLimiterSizeMetric();
        return false;
      };

      if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
        if (rejectIfGlobalRateLimited()) {
          return;
        }
        rejectAndMarkSeen("event.rejected.oversized_ciphertext");
        return;
      }

      if (rejectIfGlobalRateLimited()) {
        return;
      }

      // Verify signature (must pass before we trust the event)
      if (!verifyEvent(event)) {
        rejectAndMarkSeen("event.rejected.invalid_signature");
        onError?.(new Error("Invalid signature"), `event ${event.id}`);
        return;
      }

      let message: ReturnType<typeof unwrapNip17Message>;
      try {
        message = unwrapNip17Message(event, sk, pk);
        metrics.emit("decrypt.success");
      } catch (err) {
        rejectVerifiedAndPersist("event.rejected.decrypt_failed");
        metrics.emit("decrypt.failure");
        onError?.(err as Error, `decrypt gift wrap ${event.id}`);
        return;
      }

      if (message.senderPubkey === pk) {
        rejectVerifiedAndPersist("event.rejected.self_message");
        return;
      }
      if (rejectIfVerifiedSenderRateLimited(message.senderPubkey)) {
        markSeen();
        scheduleStatePersist(event.created_at, event.id);
        return;
      }

      const replyTo = async (text: string): Promise<void> => {
        await sendEncryptedDm(
          pool,
          sk,
          message.senderPubkey,
          text,
          relays,
          metrics,
          circuitBreakers,
          healthTracker,
          onError,
          message.rumorId,
        );
      };

      if (authorizeSender) {
        const decision = await authorizeSender({
          senderPubkey: message.senderPubkey,
          reply: replyTo,
        });
        if (decision !== "allow") {
          markSeen();
          scheduleStatePersist(event.created_at, event.id);
          return;
        }
      }

      if (Buffer.byteLength(message.content, "utf8") > guardPolicy.maxPlaintextBytes) {
        markSeen();
        metrics.emit("event.rejected.oversized_plaintext");
        scheduleStatePersist(event.created_at, event.id);
        return;
      }

      // Call the message handler
      await onMessage(message.senderPubkey, message.content, replyTo, {
        eventId: message.rumorId,
        createdAt: message.createdAt,
      });

      // Only cache successful deliveries so handler failures can retry.
      markSeen();

      // Mark as processed
      metrics.emit("event.processed");

      // Persist progress (debounced)
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err as Error, `event ${event.id}`);
    } finally {
      inflight.delete(event.id);
    }
  }

  const inboxRelayEvent = finalizeEvent(
    {
      kind: NIP17_INBOX_RELAYS_KIND,
      content: "",
      tags: relays.map((relay) => ["relay", relay]),
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );
  await Promise.allSettled(
    relays.map((relay) => publishEventWithNip42Auth(pool, relay, inboxRelayEvent, sk)),
  );

  const dmFilter = { kinds: [NIP17_GIFT_WRAP_KIND], "#p": [pk], since } satisfies Parameters<
    typeof pool.subscribeMany
  >[1];
  const relayHealth = new Map<string, SubscriptionHealth>();
  const publishAggregateHealth = () => options.onHealth?.(aggregateSubscriptionHealth(relays, relayHealth));
  const subscriptions = relays.map((relay) =>
    createSubscriptionSupervisor<Event>({
      subscribe: (callbacks) =>
        pool.subscribeMany([relay], dmFilter, {
          ...callbacks,
          onauth: async (authEvent) => finalizeEvent(authEvent, sk),
        }),
      onEvent: (event) => {
        void handleEvent(event);
      },
      onEose: () => {
        metrics.emit("relay.message.eose", 1, { relay });
        metrics.emit("relay.connect", 1, { relay });
        options.onConnect?.(relay);
        onEose?.(relay);
      },
      onClose: (reasons) => {
        metrics.emit("relay.message.closed", 1, { relay });
        metrics.emit("relay.disconnect", 1, { relay });
        options.onDisconnect?.(relay);
        onError?.(new Error(`Subscription closed: ${reasons.join(", ")}`), `subscription ${relay}`);
      },
      onReconnectAttempt: () => {
        metrics.emit("relay.reconnect", 1, { relay });
      },
      onStateChange: (health) => {
        relayHealth.set(relay, health);
        publishAggregateHealth();
      },
    }),
  );

  // Public sendDm function
  const sendDm = async (toPubkey: string, text: string): Promise<void> => {
    await sendEncryptedDm(
      pool,
      sk,
      toPubkey,
      text,
      relays,
      metrics,
      circuitBreakers,
      healthTracker,
      onError,
    );
  };

  // Profile publishing function
  const publishProfile = async (profile: NostrProfile): Promise<ProfilePublishResult> => {
    // Read last published timestamp for monotonic ordering
    const profileState = await readNostrProfileState({ accountId });
    const lastPublishedAt = profileState?.lastPublishedAt ?? undefined;

    // Publish the profile
    const result = await publishProfileFn(pool, sk, relays, profile, lastPublishedAt);

    // Convert results to state format
    const publishResults: Record<string, "ok" | "failed" | "timeout"> = {};
    for (const relay of result.successes) {
      publishResults[relay] = "ok";
    }
    for (const { relay, error } of result.failures) {
      publishResults[relay] = error === "timeout" ? "timeout" : "failed";
    }

    // Persist the publish state
    await writeNostrProfileState({
      accountId,
      lastPublishedAt: result.createdAt,
      lastPublishedEventId: result.eventId,
      lastPublishResults: publishResults,
    });

    return result;
  };

  // Get profile state function
  const getProfileState = async () => {
    const stateLocal = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: stateLocal?.lastPublishedAt ?? null,
      lastPublishedEventId: stateLocal?.lastPublishedEventId ?? null,
      lastPublishResults: stateLocal?.lastPublishResults ?? null,
    };
  };

  return {
    close: () => {
      for (const subscription of subscriptions) subscription.stop();
      pool.close(relays);
      seen.stop();
      perSenderRateLimiter.clear();
      globalRateLimiter.clear();
      // Flush pending state write synchronously on close
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({
          accountId,
          lastProcessedAt,
          gatewayStartedAt,
          recentEventIds,
        }).catch((err: unknown) => onError?.(err as Error, "persist state on close"));
      }
    },
    publicKey: pk,
    sendDm,
    getMetrics: () => metrics.getSnapshot(),
    getHealth: () => aggregateSubscriptionHealth(relays, relayHealth),
    publishProfile,
    getProfileState,
  };
}

// ============================================================================
// Send DM with Circuit Breaker + Health Scoring
// ============================================================================

/**
 * Send an encrypted DM to a pubkey
 */
async function sendEncryptedDm(
  pool: SimplePool,
  sk: Uint8Array,
  toPubkey: string,
  text: string,
  relays: string[],
  metrics: NostrMetrics,
  circuitBreakers: Map<string, CircuitBreaker>,
  healthTracker: RelayHealthTracker,
  onError?: (error: Error, context: string) => void,
  replyToEventId?: string,
): Promise<void> {
  const inboxEvent = await pool.get(relays, {
    kinds: [NIP17_INBOX_RELAYS_KIND],
    authors: [toPubkey],
  });
  const inboxRelays = readInboxRelays(inboxEvent);
  if (inboxRelays.length === 0) {
    throw new Error(`Recipient ${toPubkey} has not published NIP-17 inbox relays (kind 10050)`);
  }
  const reply = createNip17Message(sk, toPubkey, text, replyToEventId);

  // Sort relays by health score (best first)
  const sortedRelays = healthTracker.getSortedRelays(inboxRelays);

  // Replicate to every healthy advertised inbox relay. A single accepted
  // publish is enough for success, but writing to all of them prevents a
  // client from missing replies when it is temporarily reading only one.
  let lastError: Error | undefined;
  const eligibleRelays: string[] = [];
  for (const relay of sortedRelays) {
    let cb = circuitBreakers.get(relay);
    if (!cb) {
      cb = createCircuitBreaker(relay, metrics);
      circuitBreakers.set(relay, cb);
    }

    // Skip if circuit breaker is open
    if (cb && !cb.canAttempt()) {
      continue;
    }
    eligibleRelays.push(relay);
  }

  const results = await publishEventToAllRelays(pool, eligibleRelays, reply, sk);
  let successes = 0;
  for (const result of results) {
    const cb = circuitBreakers.get(result.relay);
    if (!result.error) {
      successes += 1;
      cb?.recordSuccess();
      healthTracker.recordSuccess(result.relay, result.durationMs);
      continue;
    }
    lastError = result.error;
    cb?.recordFailure();
    healthTracker.recordFailure(result.relay);
    metrics.emit("relay.error", 1, { relay: result.relay, latency: result.durationMs });
    onError?.(result.error, `publish to ${result.relay}`);
  }
  if (successes > 0) {
    return;
  }

  throw new Error(`Failed to publish to any relay: ${lastError?.message ?? "no relay available"}`);
}
