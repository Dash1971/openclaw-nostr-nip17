import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket, { WebSocketServer } from "ws";
import { startNostrBus } from "./nostr-bus.js";
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
    const secondWrap = wrapRumor(makeRumor("second"));
    const deliveries: string[] = [];
    const start = () =>
      startNostrBus({
        accountId: "replay-test",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [relayUrl],
        maxSeenEntries: 1,
        seenTtlMs: 20,
        replayRetentionMs: 10_000,
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

      await new Promise((resolve) => setTimeout(resolve, 30));
      broadcast(firstWrap);
      broadcast(rewrappedFirst);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deliveries).toEqual(["first", "second"]);

      await bus.close();
      bus = await start();
      await waitFor(() => bus.getHealth().state === "healthy");
      broadcast(rewrappedFirst);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deliveries).toEqual(["first", "second"]);
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
    const bus = await startNostrBus({
      accountId: "shutdown-test",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [`ws://127.0.0.1:${address.port}`],
      onMessage: async () => {
        handlerStarted = true;
        await handlerRelease;
      },
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
      releaseHandler();
      await closePromise;
      expect(closed).toBe(true);
      await waitFor(() => relay.clients.size === 0);
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
