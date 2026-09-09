import { createServer } from "node:http";
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
});
