import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket, { WebSocketServer } from "ws";
import { computeReplaySinceTimestamp, startNostrBus } from "./nostr-bus.js";
import { readNostrBusState, writeNostrBusState } from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

useWebSocketImplementation(WebSocket);

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Nostr bus state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Nostr bus replay and shutdown lifecycle", () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "nostr-bus-lifecycle-"));
    setNostrRuntime({
      state: { resolveStateDir: () => stateDir },
    } as never);
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("recovers out-of-order backdated messages from the durable pre-outage checkpoint", async () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const caughtUpAt = nowSec - 60 * 60;
    const previousMovingBoundary = nowSec - (2 * 24 * 60 * 60 + 300);
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const senderKey = generateSecretKey();
    const oldWraps: Event[] = [];
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs - 50 * 60 * 1000);
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(1);
    try {
      for (let index = 0; index < 2; index += 1) {
        const content = `outage-${index + 1}`;
        const rumor = createRumor(
          { kind: 14, content, tags: [["p", recipientPubkey]], created_at: nowSec - 50 * 60 },
          senderKey,
        );
        const wrap = createWrap(createSeal(rumor, senderKey, recipientPubkey), recipientPubkey);
        oldWraps.push(wrap);
      }
    } finally {
      randomSpy.mockRestore();
      dateSpy.mockRestore();
    }
    if (oldWraps.length !== 2) throw new Error("Could not create boundary-case NIP-59 wraps");
    oldWraps.sort((left, right) => right.created_at - left.created_at);
    expect(oldWraps[0]?.created_at).toBeGreaterThan(oldWraps[1]?.created_at ?? 0);
    expect(oldWraps.every((event) => event.created_at < previousMovingBoundary)).toBe(true);

    await writeNostrBusState({
      accountId: "outage-catchup-test",
      lastProcessedAt: caughtUpAt,
      gatewayStartedAt: caughtUpAt,
      caughtUpAt,
    });

    const server = createServer();
    const relay = new WebSocketServer({ server });
    let requestedSince: number | undefined;
    relay.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const event = message[1] as Event;
          socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          const filter = message[2] as { kinds?: number[]; since?: number } | undefined;
          if (filter?.kinds?.includes(1059)) {
            requestedSince = filter.since;
            for (const event of oldWraps) {
              socket.send(JSON.stringify(["EVENT", message[1], event]));
            }
          }
          socket.send(JSON.stringify(["EOSE", message[1]]));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Relay did not expose a port");
    const deliveries: string[] = [];
    const bus = await startNostrBus({
      accountId: "outage-catchup-test",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [`ws://127.0.0.1:${address.port}`],
      statePersistIntervalMs: 50,
      onMessage: async (_sender, text) => {
        deliveries.push(text);
      },
    });

    try {
      await waitFor(() => deliveries.length === 2);
      expect(requestedSince).toBe(computeReplaySinceTimestamp(caughtUpAt));
      expect(oldWraps.every((event) => event.created_at >= (requestedSince ?? 0))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const advanced = await readNostrBusState({ accountId: "outage-catchup-test" });
      expect(advanced?.caughtUpAt).toBeGreaterThanOrEqual(nowSec);
    } finally {
      await bus.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("blocks identical and rewrapped rumor replay after cache eviction, expiry, and restart", async () => {
    const server = createServer();
    const relay = new WebSocketServer({ server });
    const subscriptions = new Map<WebSocket, Set<string>>();

    relay.on("connection", (socket) => {
      subscriptions.set(socket, new Set());
      socket.on("close", () => subscriptions.delete(socket));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const event = message[1] as Event;
          socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          subscriptions.get(socket)?.add(message[1]);
          socket.send(JSON.stringify(["EOSE", message[1]]));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Relay did not expose a port");
    const relayUrl = `ws://127.0.0.1:${address.port}`;
    const broadcast = (event: Event) => {
      for (const [socket, ids] of subscriptions) {
        for (const id of ids) socket.send(JSON.stringify(["EVENT", id, event]));
      }
    };

    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const senderKey = generateSecretKey();
    const makeRumor = (content: string) =>
      createRumor(
        {
          kind: 14,
          content,
          tags: [["p", recipientPubkey]],
          created_at: Math.floor(Date.now() / 1000),
        },
        senderKey,
      );
    const wrapRumor = (rumor: ReturnType<typeof makeRumor>) =>
      createWrap(createSeal(rumor, senderKey, recipientPubkey), recipientPubkey);
    const firstRumor = makeRumor("first");
    const firstWrap = wrapRumor(firstRumor);
    const rewrappedFirst = wrapRumor(firstRumor);
    const rewrappedFirstAfterRestart = wrapRumor(firstRumor);
    const secondWrap = wrapRumor(makeRumor("second"));
    const thirdWrap = wrapRumor(makeRumor("third"));
    const fourthWrap = wrapRumor(makeRumor("fourth"));
    const deliveries: string[] = [];
    let replayNow = 1_800_000_000_000;
    const start = () =>
      startNostrBus({
        accountId: "replay-test",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [relayUrl],
        maxSeenEntries: 1,
        seenTtlMs: 20,
        replayRetentionMs: 1_000,
        statePersistIntervalMs: 100,
        now: () => replayNow,
        onMessage: async (_sender, text) => {
          deliveries.push(text);
        },
      });

    let bus = await start();
    try {
      await waitFor(() => bus.getHealth().state === "healthy");
      broadcast(firstWrap);
      await waitFor(() => deliveries.length === 1);
      broadcast(secondWrap);
      await waitFor(() => deliveries.length === 2);

      // Traffic arriving more frequently than the persistence interval must
      // not postpone the first durable write.
      await new Promise((resolve) => setTimeout(resolve, 40));
      broadcast(thirdWrap);
      await waitFor(() => deliveries.length === 3);
      await new Promise((resolve) => setTimeout(resolve, 40));
      broadcast(fourthWrap);
      await waitFor(() => deliveries.length === 4);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const crashSnapshot = await readNostrBusState({ accountId: "replay-test" });
      expect(crashSnapshot?.processedRumorIds?.some((entry) => entry.id === firstRumor.id)).toBe(
        true,
      );

      // Restore only the already-written state into a second lifecycle. This
      // models abrupt process loss without invoking the first bus's close flush.
      if (!crashSnapshot) throw new Error("Missing bounded persistence snapshot");
      await writeNostrBusState({
        accountId: "replay-crash-recovery",
        lastProcessedAt: crashSnapshot.lastProcessedAt ?? Math.floor(Date.now() / 1000),
        gatewayStartedAt: crashSnapshot.gatewayStartedAt ?? Math.floor(Date.now() / 1000),
        caughtUpAt: crashSnapshot.caughtUpAt ?? undefined,
        recentEventIds: crashSnapshot.recentEventIds,
        recentRumorIds: crashSnapshot.recentRumorIds,
        processedRumorIds: crashSnapshot.processedRumorIds,
      });
      const crashRecoveryDeliveries: string[] = [];
      const crashRecovery = await startNostrBus({
        accountId: "replay-crash-recovery",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [relayUrl],
        maxSeenEntries: 1,
        seenTtlMs: 20,
        replayRetentionMs: 1_000,
        statePersistIntervalMs: 100,
        now: () => replayNow,
        onMessage: async (_sender, text) => {
          crashRecoveryDeliveries.push(text);
        },
      });
      try {
        await waitFor(() => crashRecovery.getHealth().state === "healthy");
        broadcast(wrapRumor(firstRumor));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(crashRecoveryDeliveries).toEqual([]);
      } finally {
        await crashRecovery.close();
      }

      replayNow += 600;
      broadcast(rewrappedFirst);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliveries).toEqual(["first", "second", "third", "fourth"]);

      // The original completion is now beyond durable retention, but the
      // later verified wrap extended the rumor's replay horizon.
      replayNow += 500;
      broadcast(firstWrap);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliveries).toEqual(["first", "second", "third", "fourth"]);

      await bus.close();
      bus = await start();
      await waitFor(() => bus.getHealth().state === "healthy");
      broadcast(rewrappedFirstAfterRestart);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deliveries).toEqual(["first", "second", "third", "fourth"]);
    } finally {
      await bus.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("waits for an in-flight handler before closing relay resources", async () => {
    const server = createServer();
    const relay = new WebSocketServer({ server });
    let subscription: { socket: WebSocket; id: string } | null = null;
    relay.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const event = message[1] as Event;
          socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          subscription = { socket, id: message[1] };
          socket.send(JSON.stringify(["EOSE", message[1]]));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Relay did not expose a port");

    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const senderKey = generateSecretKey();
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    let lateReplyResult: "pending" | "blocked" | "sent" = "pending";
    const bus = await startNostrBus({
      accountId: "shutdown-test",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [`ws://127.0.0.1:${address.port}`],
      onMessage: async (_sender, _text, reply) => {
        handlerStarted = true;
        await handlerRelease;
        try {
          await reply("late reply");
          lateReplyResult = "sent";
        } catch {
          lateReplyResult = "blocked";
        }
      },
      shutdownDrainMs: 100,
    });

    try {
      await waitFor(() => bus.getHealth().state === "healthy" && subscription !== null);
      const event = createWrap(
        createSeal(
          createRumor(
            { kind: 14, content: "wait", tags: [["p", recipientPubkey]] },
            senderKey,
          ),
          senderKey,
          recipientPubkey,
        ),
        recipientPubkey,
      );
      const target = subscription as { socket: WebSocket; id: string } | null;
      if (!target) throw new Error("Missing relay subscription");
      target.socket.send(JSON.stringify(["EVENT", target.id, event]));
      await waitFor(() => handlerStarted);

      let closed = false;
      const closePromise = bus.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);
      await closePromise;
      expect(closed).toBe(true);
      await waitFor(() => relay.clients.size === 0);

      let replacementDeliveries = 0;
      const replacement = await startNostrBus({
        accountId: "shutdown-test",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [`ws://127.0.0.1:${address.port}`],
        onMessage: async () => {
          replacementDeliveries += 1;
        },
        shutdownDrainMs: 100,
      });
      try {
        await waitFor(() => replacement.getHealth().state === "healthy" && subscription !== null);
        const targetAfterRestart = subscription as { socket: WebSocket; id: string } | null;
        if (!targetAfterRestart) throw new Error("Missing replacement relay subscription");
        targetAfterRestart.socket.send(JSON.stringify(["EVENT", targetAfterRestart.id, event]));
        await waitFor(() => replacementDeliveries === 1);
        releaseHandler();
        await waitFor(() => lateReplyResult !== "pending");
        expect(lateReplyResult).toBe("blocked");
        expect(replacementDeliveries).toBe(1);
      } finally {
        await replacement.close();
      }
    } finally {
      releaseHandler();
      await bus.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
