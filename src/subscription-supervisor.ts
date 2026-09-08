export type SubscriptionHealthState = "connecting" | "healthy" | "degraded" | "stopped";

export interface SubscriptionHealth {
  state: SubscriptionHealthState;
  generation: number;
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastEventAt: number | null;
  lastEoseAt: number | null;
  lastError: string | null;
}

export interface SubscriptionCallbacks<EventType> {
  onevent: (event: EventType) => void;
  oneose: () => void;
  onclose: (reasons: string[]) => void;
}

export interface SubscriptionCloser {
  close: (reason?: string) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export function createSubscriptionSupervisor<EventType>(options: {
  subscribe: (callbacks: SubscriptionCallbacks<EventType>) => SubscriptionCloser;
  onEvent: (event: EventType) => void;
  onEose?: () => void;
  onClose?: (reasons: string[]) => void;
  onReconnectAttempt?: (attempt: number) => void;
  onStateChange?: (health: SubscriptionHealth) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  connectionTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}) {
  const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? 1_000));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? 60_000));
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
  const connectionTimeoutMs = Math.max(1, Math.floor(options.connectionTimeoutMs ?? 30_000));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? clearTimeout;

  let stopped = false;
  let callbackToken = 0;
  let current: SubscriptionCloser | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let connectionTimer: TimerHandle | null = null;
  let health: SubscriptionHealth = {
    state: "connecting",
    generation: 0,
    reconnectAttempts: 0,
    nextReconnectAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastEventAt: null,
    lastEoseAt: null,
    lastError: null,
  };

  const publishState = () => options.onStateChange?.({ ...health });

  const markHealthy = (kind: "event" | "eose") => {
    if (connectionTimer) {
      cancel(connectionTimer);
      connectionTimer = null;
    }
    const timestamp = now();
    health = {
      ...health,
      state: "healthy",
      reconnectAttempts: 0,
      nextReconnectAt: null,
      lastConnectedAt: timestamp,
      lastEventAt: kind === "event" ? timestamp : health.lastEventAt,
      lastEoseAt: kind === "eose" ? timestamp : health.lastEoseAt,
      lastError: null,
    };
    publishState();
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const attempt = health.reconnectAttempts + 1;
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(20, attempt - 1));
    const jitter = exponentialDelay * jitterRatio * (random() * 2 - 1);
    const delayMs = Math.max(1, Math.round(exponentialDelay + jitter));
    health = {
      ...health,
      state: "degraded",
      reconnectAttempts: attempt,
      nextReconnectAt: now() + delayMs,
    };
    publishState();
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      if (stopped) return;
      options.onReconnectAttempt?.(attempt);
      openSubscription();
    }, delayMs);
  };

  const handleClose = (token: number, reasons: string[]) => {
    if (stopped || token !== callbackToken) return;
    if (connectionTimer) {
      cancel(connectionTimer);
      connectionTimer = null;
    }
    callbackToken += 1;
    current = null;
    const normalizedReasons = reasons.filter(Boolean);
    health = {
      ...health,
      state: "degraded",
      lastDisconnectedAt: now(),
      lastError: normalizedReasons.join(", ") || "subscription closed",
    };
    options.onClose?.(normalizedReasons);
    scheduleReconnect();
  };

  function openSubscription() {
    if (stopped) return;
    const token = ++callbackToken;
    health = {
      ...health,
      state: "connecting",
      generation: health.generation + 1,
      nextReconnectAt: null,
    };
    publishState();
    connectionTimer = schedule(() => {
      connectionTimer = null;
      if (stopped || token !== callbackToken) return;
      const timedOut = current;
      handleClose(token, [`subscription did not receive an event or EOSE within ${connectionTimeoutMs}ms`]);
      timedOut?.close("subscription health timeout");
    }, connectionTimeoutMs);
    try {
      const next = options.subscribe({
        onevent: (event) => {
          if (stopped || token !== callbackToken) return;
          markHealthy("event");
          options.onEvent(event);
        },
        oneose: () => {
          if (stopped || token !== callbackToken) return;
          markHealthy("eose");
          options.onEose?.();
        },
        onclose: (reasons) => handleClose(token, reasons),
      });
      if (stopped || token !== callbackToken) {
        next.close("superseded subscription");
      } else {
        current = next;
      }
    } catch (error) {
      handleClose(token, [error instanceof Error ? error.message : String(error)]);
    }
  }

  openSubscription();

  return {
    getHealth: (): SubscriptionHealth => ({ ...health }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      callbackToken += 1;
      if (reconnectTimer) {
        cancel(reconnectTimer);
        reconnectTimer = null;
      }
      if (connectionTimer) {
        cancel(connectionTimer);
        connectionTimer = null;
      }
      current?.close("closed by caller");
      current = null;
      health = { ...health, state: "stopped", nextReconnectAt: null };
      publishState();
    },
  };
}
