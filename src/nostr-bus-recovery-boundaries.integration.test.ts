import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket, { WebSocketServer } from "ws";
import { startNostrBus } from "./nostr-bus.js";
import { readNostrBusState, writeNostrBusState } from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

useWebSocketImplementation(WebSocket);

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for recovery boundary state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function createBoundaryWrap(params: {
  recipientPubkey: string;
  senderKey: Uint8Array;
  nowMs: number;
  content: string;
}): Event {
  const dateSpy = vi.spyOn(Date, "now").mockReturnValue(params.nowMs - 50 * 60 * 1000);
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
  try {
    const rumor = createRumor(
      {
        kind: 14,
        content: params.content,
        tags: [["p", params.recipientPubkey]],
        created_at: Math.floor(params.nowMs / 1000) - 50 * 60,
      },
      params.senderKey,
    );
    return createWrap(
      createSeal(rumor, params.senderKey, params.recipientPubkey),
      params.recipientPubkey,
    );
  } finally {
    randomSpy.mockRestore();
    dateSpy.mockRestore();
  }
}

describe("Nostr bus recovery boundaries", () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "nostr-recovery-boundaries-"));
    setNostrRuntime({ state: { resolveStateDir: () => stateDir } } as never);
  });

  afterAll(async () => {
    useWebSocketImplementation(WebSocket);
    await rm(stateDir, { recursive: true, force: true });
  });

  it(
    "does not advance catch-up when the locked transport reaches its default EOSE timeout",
    async () => {
      const nowMs = Date.now();
      const caughtUpAt = Math.floor(nowMs / 1000) - 60 * 60;
      const recipientKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientKey);
      const event = createBoundaryWrap({
        recipientPubkey,
        senderKey: generateSecretKey(),
        nowMs,
        content: "delayed backlog",
      });
      await writeNostrBusState({
        accountId: "no-wire-eose",
        lastProcessedAt: caughtUpAt,
        gatewayStartedAt: caughtUpAt,
        caughtUpAt,
      });

      const server = createServer();
      const relay = new WebSocketServer({ server });
      let subscription: { socket: WebSocket; id: string } | null = null;
      relay.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as unknown[];
          if (message[0] === "EVENT") {
            const published = message[1] as Event;
            socket.send(JSON.stringify(["OK", published.id, true, "accepted"]));
          }
          if (message[0] === "REQ" && typeof message[1] === "string") {
            const filter = message[2] as { kinds?: number[] } | undefined;
            if (filter?.kinds?.includes(1059)) {
              subscription = { socket, id: message[1] };
              // Deliberately withhold wire EOSE.
            }
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
        accountId: "no-wire-eose",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [`ws://127.0.0.1:${address.port}`],
        statePersistIntervalMs: 50,
        onMessage: async (_sender, text) => {
          deliveries.push(text);
        },
      });

      try {
        await waitFor(() => subscription !== null);
        await new Promise((resolve) => setTimeout(resolve, 4_600));
        const beforeBacklog = await readNostrBusState({ accountId: "no-wire-eose" });
        expect(beforeBacklog?.caughtUpAt).toBe(caughtUpAt);

        const target = subscription as { socket: WebSocket; id: string } | null;
        if (!target) throw new Error("Missing delayed subscription");
        target.socket.send(JSON.stringify(["EVENT", target.id, event]));
        await waitFor(() => deliveries.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 75));
        const afterBacklog = await readNostrBusState({ accountId: "no-wire-eose" });
        expect(afterBacklog?.caughtUpAt).toBe(caughtUpAt);
      } finally {
        await bus.close();
        for (const socket of relay.clients) socket.terminate();
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    10_000,
  );

  it("keeps the checkpoint behind a transient handler failure and retries after restart", async () => {
    const nowMs = Date.now();
    const caughtUpAt = Math.floor(nowMs / 1000) - 60 * 60;
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const event = createBoundaryWrap({
      recipientPubkey,
      senderKey: generateSecretKey(),
      nowMs,
      content: "retry after failure",
    });
    await writeNostrBusState({
      accountId: "handler-retry",
      lastProcessedAt: caughtUpAt,
      gatewayStartedAt: caughtUpAt,
      caughtUpAt,
    });

    const server = createServer();
    const relay = new WebSocketServer({ server });
    relay.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const published = message[1] as Event;
          socket.send(JSON.stringify(["OK", published.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          const filter = message[2] as { kinds?: number[] } | undefined;
          if (filter?.kinds?.includes(1059)) {
            socket.send(JSON.stringify(["EVENT", message[1], event]));
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
    const relayUrl = `ws://127.0.0.1:${address.port}`;
    let failedAttempts = 0;
    const failing = await startNostrBus({
      accountId: "handler-retry",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [relayUrl],
      statePersistIntervalMs: 50,
      onMessage: async () => {
        failedAttempts += 1;
        throw new Error("transient handler failure");
      },
    });

    try {
      await waitFor(() => failedAttempts === 1);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const failedState = await readNostrBusState({ accountId: "handler-retry" });
      expect(failedState?.caughtUpAt).toBe(caughtUpAt);
      expect(failedState?.processedRumorIds ?? []).toEqual([]);
    } finally {
      await failing.close();
    }

    let recovered = 0;
    const replacement = await startNostrBus({
      accountId: "handler-retry",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [relayUrl],
      onMessage: async () => {
        recovered += 1;
      },
    });
    try {
      await waitFor(() => recovered === 1);
    } finally {
      await replacement.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps the checkpoint behind a retryable global rate-limit outcome", async () => {
    const nowMs = Date.now();
    const caughtUpAt = Math.floor(nowMs / 1000) - 60 * 60;
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const events = ["first delivery", "rate-limited delivery"].map((content) =>
      createBoundaryWrap({
        recipientPubkey,
        senderKey: generateSecretKey(),
        nowMs,
        content,
      }),
    );
    await writeNostrBusState({
      accountId: "rate-limit-retry",
      lastProcessedAt: caughtUpAt,
      gatewayStartedAt: caughtUpAt,
      caughtUpAt,
    });

    const server = createServer();
    const relay = new WebSocketServer({ server });
    relay.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const published = message[1] as Event;
          socket.send(JSON.stringify(["OK", published.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          const filter = message[2] as { kinds?: number[] } | undefined;
          if (filter?.kinds?.includes(1059)) {
            for (const event of events) {
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
      accountId: "rate-limit-retry",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [`ws://127.0.0.1:${address.port}`],
      statePersistIntervalMs: 50,
      guardPolicy: {
        rateLimit: {
          maxGlobalPerWindow: 1,
          windowMs: 60_000,
        },
      },
      onMessage: async (_sender, text) => {
        deliveries.push(text);
      },
    });

    try {
      await waitFor(() => deliveries.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const state = await readNostrBusState({ accountId: "rate-limit-retry" });
      expect(state?.caughtUpAt).toBe(caughtUpAt);
      expect(state?.processedRumorIds).toHaveLength(1);
    } finally {
      await bus.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not certify a multi-relay checkpoint while another relay generation is pending", async () => {
    const nowMs = Date.now();
    const caughtUpAt = Math.floor(nowMs / 1000) - 60 * 60;
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const eventA = createBoundaryWrap({
      recipientPubkey,
      senderKey: generateSecretKey(),
      nowMs,
      content: "relay A backlog",
    });
    const eventB = createBoundaryWrap({
      recipientPubkey,
      senderKey: generateSecretKey(),
      nowMs,
      content: "relay B backlog",
    });
    await writeNostrBusState({
      accountId: "multi-relay-pending",
      lastProcessedAt: caughtUpAt,
      gatewayStartedAt: caughtUpAt,
      caughtUpAt,
    });

    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const started = new Set<string>();
    const eoseRelays = new Set<string>();
    const server = createServer();
    const relay = new WebSocketServer({ server });
    relay.on("connection", (socket, request) => {
      const relayName = request.url === "/a" ? "a" : "b";
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const published = message[1] as Event;
          socket.send(JSON.stringify(["OK", published.id, true, "accepted"]));
        }
        if (message[0] === "REQ" && typeof message[1] === "string") {
          const filter = message[2] as { kinds?: number[] } | undefined;
          if (!filter?.kinds?.includes(1059)) {
            socket.send(JSON.stringify(["EOSE", message[1]]));
            return;
          }
          if (relayName === "a") {
            socket.send(JSON.stringify(["EVENT", message[1], eventA]));
            socket.send(JSON.stringify(["EOSE", message[1]]));
            return;
          }
          void waitFor(() => started.has("relay A backlog")).then(() => {
            socket.send(JSON.stringify(["EVENT", message[1], eventB]));
            socket.send(JSON.stringify(["EOSE", message[1]]));
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Relay did not expose a port");
    const relayA = `ws://127.0.0.1:${address.port}/a`;
    const relayB = `ws://127.0.0.1:${address.port}/b`;
    const bus = await startNostrBus({
      accountId: "multi-relay-pending",
      privateKey: Buffer.from(recipientKey).toString("hex"),
      relays: [relayA, relayB],
      statePersistIntervalMs: 50,
      shutdownDrainMs: 100,
      onEose: (url) => eoseRelays.add(url),
      onMessage: async (_sender, text) => {
        started.add(text);
        if (text === "relay A backlog") await gateA;
        if (text === "relay B backlog") {
          await gateB;
          throw new Error("relay B transient failure");
        }
      },
    });

    try {
      await waitFor(() => started.size === 2 && eoseRelays.size === 2);
      releaseA();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const whileBPending = await readNostrBusState({ accountId: "multi-relay-pending" });
      expect(whileBPending?.caughtUpAt).toBe(caughtUpAt);
      expect(whileBPending?.processedRumorIds).toHaveLength(1);

      await bus.close();
      const afterBoundedClose = await readNostrBusState({ accountId: "multi-relay-pending" });
      expect(afterBoundedClose?.caughtUpAt).toBe(caughtUpAt);
      expect(afterBoundedClose?.processedRumorIds).toHaveLength(1);
      releaseB();

      let recoveredB = 0;
      const replacement = await startNostrBus({
        accountId: "multi-relay-pending",
        privateKey: Buffer.from(recipientKey).toString("hex"),
        relays: [relayA, relayB],
        onMessage: async (_sender, text) => {
          if (text === "relay B backlog") recoveredB += 1;
        },
      });
      try {
        await waitFor(() => recoveredB === 1);
      } finally {
        await replacement.close();
      }
    } finally {
      releaseA();
      releaseB();
      await bus.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("aborts pending inbox discovery without opening or publishing to a relay after close", async () => {
    const routes = new Map<string, string>();
    class RoutedWebSocket extends WebSocket {
      constructor(address: string | URL) {
        const original = String(address);
        super(routes.get(original) ?? routes.get(original.replace(/\/$/, "")) ?? original);
      }
    }
    useWebSocketImplementation(RoutedWebSocket);

    const server = createServer();
    const relay = new WebSocketServer({ server });
    const recipientKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientKey);
    const discoveredRelay = "wss://recipient-relay.example";
    const inboxEvent = finalizeEvent(
      {
        kind: 10050,
        content: "",
        tags: [["relay", discoveredRelay]],
        created_at: Math.floor(Date.now() / 1000),
      },
      recipientKey,
    );
    let discoveryStarted = false;
    let discoveredConnections = 0;
    let discoveredPublications = 0;
    relay.on("connection", (socket, request) => {
      const discovered = request.url === "/recipient";
      if (discovered) discoveredConnections += 1;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "EVENT") {
          const event = message[1] as Event;
          if (discovered && event.kind === 1059) discoveredPublications += 1;
          socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
        }
        if (!discovered && message[0] === "REQ" && typeof message[1] === "string") {
          const filter = message[2] as { kinds?: number[] } | undefined;
          if (filter?.kinds?.includes(10050)) {
            discoveryStarted = true;
            socket.send(JSON.stringify(["EVENT", message[1], inboxEvent]));
            return; // Deliberately withhold EOSE so discovery remains pending.
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
    const configuredRelay = `ws://127.0.0.1:${address.port}/configured`;
    routes.set(discoveredRelay, `ws://127.0.0.1:${address.port}/recipient`);
    routes.set(`${discoveredRelay}/`, `ws://127.0.0.1:${address.port}/recipient`);

    const bus = await startNostrBus({
      accountId: "pending-discovery-close",
      privateKey: Buffer.from(generateSecretKey()).toString("hex"),
      relays: [configuredRelay],
      websocketImplementation: RoutedWebSocket,
      shutdownDrainMs: 100,
      onMessage: async () => {},
    });
    const sendResult = bus.sendDm(recipientPubkey, "must not publish").then(
      () => "sent" as const,
      () => "blocked" as const,
    );

    try {
      await waitFor(() => discoveryStarted);
      await bus.close();
      expect(await sendResult).toBe("blocked");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(discoveredConnections).toBe(0);
      expect(discoveredPublications).toBe(0);
    } finally {
      await bus.close();
      useWebSocketImplementation(WebSocket);
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it(
    "aborts a pending relay handshake without false success or a surviving socket",
    async () => {
      const routes = new Map<string, string>();
      const recipientClients: WebSocket[] = [];
      class RoutedWebSocket extends WebSocket {
        constructor(address: string | URL) {
          const original = String(address);
          super(routes.get(original) ?? routes.get(original.replace(/\/$/, "")) ?? original);
          if (original.startsWith("wss://held-recipient-relay.example")) {
            recipientClients.push(this);
          }
        }
      }

      const server = createServer();
      const relay = new WebSocketServer({ noServer: true });
      const recipientKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientKey);
      const discoveredRelay = "wss://held-recipient-relay.example";
      const inboxEvent = finalizeEvent(
        {
          kind: 10050,
          content: "",
          tags: [["relay", discoveredRelay]],
          created_at: Math.floor(Date.now() / 1000),
        },
        recipientKey,
      );
      let discoveryStarted = false;
      let heldUpgradeSocket: Duplex | null = null;
      let heldUpgrade:
        | { request: Parameters<typeof relay.handleUpgrade>[0]; head: Buffer }
        | null = null;
      let liveRecipientConnections = 0;
      let recipientPublications = 0;
      server.on("upgrade", (request, socket, head) => {
        if (request.url === "/recipient") {
          heldUpgradeSocket = socket;
          heldUpgrade = { request, head };
          return;
        }
        relay.handleUpgrade(request, socket, head, (websocket) => {
          relay.emit("connection", websocket, request);
        });
      });
      relay.on("connection", (socket, request) => {
        if (request.url === "/recipient") {
          liveRecipientConnections += 1;
          socket.once("close", () => {
            liveRecipientConnections -= 1;
          });
        }
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as unknown[];
          if (message[0] === "EVENT") {
            const event = message[1] as Event;
            if (request.url === "/recipient" && event.kind === 1059) {
              recipientPublications += 1;
            }
            socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
          }
          if (message[0] === "REQ" && typeof message[1] === "string") {
            const filter = message[2] as { kinds?: number[] } | undefined;
            if (filter?.kinds?.includes(10050)) {
              discoveryStarted = true;
              socket.send(JSON.stringify(["EVENT", message[1], inboxEvent]));
              socket.send(JSON.stringify(["EOSE", message[1]]));
              return;
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
      const configuredRelay = `ws://127.0.0.1:${address.port}/configured`;
      routes.set(discoveredRelay, `ws://127.0.0.1:${address.port}/recipient`);
      routes.set(`${discoveredRelay}/`, `ws://127.0.0.1:${address.port}/recipient`);

      const bus = await startNostrBus({
        accountId: "pending-handshake-close",
        privateKey: Buffer.from(generateSecretKey()).toString("hex"),
        relays: [configuredRelay],
        websocketImplementation: RoutedWebSocket,
        onMessage: async () => {},
      });
      const sendResult = bus.sendDm(recipientPubkey, "must not report success").then(
        () => "sent" as const,
        () => "blocked" as const,
      );

      try {
        await waitFor(() => discoveryStarted);
        await waitFor(() => heldUpgradeSocket !== null);
        await bus.close();
        expect(await sendResult).toBe("blocked");
        expect(recipientClients).toHaveLength(1);
        expect(recipientClients[0]?.readyState).not.toBe(WebSocket.CONNECTING);
        expect(recipientClients[0]?.readyState).not.toBe(WebSocket.OPEN);
        const pending = heldUpgrade as
          | { request: Parameters<typeof relay.handleUpgrade>[0]; head: Buffer }
          | null;
        const pendingSocket = heldUpgradeSocket as Duplex | null;
        if (pending && pendingSocket && !pendingSocket.destroyed) {
          try {
            relay.handleUpgrade(pending.request, pendingSocket, pending.head, (websocket) => {
              relay.emit("connection", websocket, pending.request);
            });
          } catch {
            // A synchronously rejected upgrade also proves the socket cannot survive.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(recipientClients[0]?.readyState).toBe(WebSocket.CLOSED);
        expect(liveRecipientConnections).toBe(0);
        expect(recipientPublications).toBe(0);
      } finally {
        await bus.close();
        (heldUpgradeSocket as Duplex | null)?.destroy();
        for (const socket of relay.clients) socket.terminate();
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    10_000,
  );
});
