import { describe, expect, it, vi } from "vitest";
import {
  createSubscriptionSupervisor,
  type SubscriptionCallbacks,
} from "./subscription-supervisor.js";

describe("subscription supervisor", () => {
  it("recreates a closed multi-relay subscription once and becomes healthy", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const closes = vi.fn();
    const states: string[] = [];
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close: closes };
      },
      onEvent: vi.fn(),
      onStateChange: (health) => states.push(health.state),
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["relay one failed", "relay two closed", "relay three timed out"]);
    callbacks[0]!.onclose(["duplicate stale close"]);
    expect(supervisor.getHealth()).toMatchObject({
      state: "degraded",
      reconnectAttempts: 1,
      lastError: "relay one failed, relay two closed, relay three timed out",
    });

    vi.advanceTimersByTime(999);
    expect(callbacks).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(callbacks).toHaveLength(2);
    callbacks[1]!.oneose();
    expect(supervisor.getHealth()).toMatchObject({ state: "healthy", reconnectAttempts: 1 });
    vi.advanceTimersByTime(30_000);
    expect(supervisor.getHealth()).toMatchObject({ state: "healthy", reconnectAttempts: 0 });
    expect(states).toContain("degraded");
    supervisor.stop();
    vi.useRealTimers();
  });

  it("uses capped exponential backoff across repeated failures", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const attempts: number[] = [];
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close: vi.fn() };
      },
      onEvent: vi.fn(),
      onReconnectAttempt: (attempt) => attempts.push(attempt),
      baseDelayMs: 100,
      maxDelayMs: 250,
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["first"]);
    vi.advanceTimersByTime(100);
    callbacks[1]!.onclose(["second"]);
    vi.advanceTimersByTime(200);
    callbacks[2]!.onclose(["third"]);
    vi.advanceTimersByTime(250);
    expect(callbacks).toHaveLength(4);
    expect(attempts).toEqual([1, 2, 3]);
    supervisor.stop();
    vi.useRealTimers();
  });

  it("does not let EOSE reset backoff before an auth-required close", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const attempts: number[] = [];
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close: vi.fn() };
      },
      onEvent: vi.fn(),
      onReconnectAttempt: (attempt) => attempts.push(attempt),
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      stabilityResetMs: 5_000,
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["auth-required"]);
    vi.advanceTimersByTime(100);
    callbacks[1]!.oneose();
    callbacks[1]!.onclose(["auth-required"]);
    vi.advanceTimersByTime(199);
    expect(callbacks).toHaveLength(2);
    vi.advanceTimersByTime(1);
    callbacks[2]!.oneose();
    callbacks[2]!.onclose(["auth-required"]);
    vi.advanceTimersByTime(400);
    expect(callbacks).toHaveLength(4);
    expect(attempts).toEqual([1, 2, 3]);
    supervisor.stop();
    vi.useRealTimers();
  });

  it("resets accumulated attempts only after the same subscription stays healthy", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const attempts: number[] = [];
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close: vi.fn() };
      },
      onEvent: vi.fn(),
      onReconnectAttempt: (attempt) => attempts.push(attempt),
      baseDelayMs: 100,
      stabilityResetMs: 500,
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["temporary"]);
    vi.advanceTimersByTime(100);
    callbacks[1]!.oneose();
    expect(supervisor.getHealth().reconnectAttempts).toBe(1);
    vi.advanceTimersByTime(500);
    expect(supervisor.getHealth().reconnectAttempts).toBe(0);
    callbacks[1]!.onclose(["later"]);
    vi.advanceTimersByTime(100);
    expect(attempts).toEqual([1, 1]);
    supervisor.stop();
    vi.useRealTimers();
  });

  it("does not let a retired subscription's stability timer reset a replacement", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close: vi.fn() };
      },
      onEvent: vi.fn(),
      baseDelayMs: 100,
      stabilityResetMs: 500,
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["first"]);
    vi.advanceTimersByTime(100);
    callbacks[1]!.oneose();
    callbacks[1]!.onclose(["auth-required"]);
    vi.advanceTimersByTime(200);
    callbacks[2]!.oneose();
    vi.advanceTimersByTime(300);
    expect(supervisor.getHealth().reconnectAttempts).toBe(2);
    vi.advanceTimersByTime(200);
    expect(supervisor.getHealth().reconnectAttempts).toBe(0);
    supervisor.stop();
    vi.useRealTimers();
  });

  it("cancels a pending reconnect when stopped", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const close = vi.fn();
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close };
      },
      onEvent: vi.fn(),
      random: () => 0.5,
    });

    callbacks[0]!.onclose(["failed"]);
    supervisor.stop();
    vi.runAllTimers();
    expect(callbacks).toHaveLength(1);
    expect(supervisor.getHealth().state).toBe("stopped");
    vi.useRealTimers();
  });

  it("reconnects when a subscription never receives an event or EOSE", () => {
    vi.useFakeTimers();
    const callbacks: Array<SubscriptionCallbacks<string>> = [];
    const close = vi.fn();
    const supervisor = createSubscriptionSupervisor({
      subscribe: (next) => {
        callbacks.push(next);
        return { close };
      },
      onEvent: vi.fn(),
      connectionTimeoutMs: 500,
      baseDelayMs: 100,
      random: () => 0.5,
    });

    vi.advanceTimersByTime(500);
    expect(close).toHaveBeenCalledWith("subscription health timeout");
    expect(supervisor.getHealth()).toMatchObject({
      state: "degraded",
      reconnectAttempts: 1,
    });
    vi.advanceTimersByTime(100);
    expect(callbacks).toHaveLength(2);
    supervisor.stop();
    vi.useRealTimers();
  });
});
