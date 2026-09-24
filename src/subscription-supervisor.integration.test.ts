import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket, { WebSocketServer } from "ws";
import { createSubscriptionSupervisor } from "./subscription-supervisor.js";

useWebSocketImplementation(WebSocket);

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for controlled relay state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("subscription supervisor with a controlled WebSocket relay", () => {
  const pools: SimplePool[] = [];

  afterAll(() => {
    for (const pool of pools) pool.destroy();
  });

  it("recovers one failed relay without recycling a healthy relay and stays stopped", async () => {
    const server = createServer();
    const relay = new WebSocketServer({ server });
    const sockets = new Map<string, Set<WebSocket>>();
    const connectionCounts = new Map<string, number>();

    relay.on("connection", (socket, request) => {
      const path = request.url ?? "/";
      connectionCounts.set(path, (connectionCounts.get(path) ?? 0) + 1);
      const pathSockets = sockets.get(path) ?? new Set<WebSocket>();
      pathSockets.add(socket);
      sockets.set(path, pathSockets);
      socket.on("close", () => pathSockets.delete(socket));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "REQ" && typeof message[1] === "string") {
          socket.send(JSON.stringify(["EOSE", message[1]]));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Controlled relay did not expose a TCP port");
    }

    const pool = new SimplePool({ enablePing: false, enableReconnect: false });
    pools.push(pool);
    const createSupervisor = (path: string) =>
      createSubscriptionSupervisor({
        subscribe: (callbacks) =>
          pool.subscribeMany(
            [`ws://127.0.0.1:${address.port}${path}`],
            { kinds: [1059] },
            { ...callbacks, maxWait: 500 },
          ),
        onEvent: () => undefined,
        baseDelayMs: 20,
        maxDelayMs: 50,
        connectionTimeoutMs: 1_000,
        random: () => 0.5,
      });
    const failedRelay = createSupervisor("/failed-relay");
    const healthyRelay = createSupervisor("/healthy-relay");

    try {
      await waitFor(
        () =>
          failedRelay.getHealth().state === "healthy" &&
          healthyRelay.getHealth().state === "healthy",
      );
      expect(connectionCounts.get("/failed-relay")).toBe(1);
      expect(connectionCounts.get("/healthy-relay")).toBe(1);

      [...(sockets.get("/failed-relay") ?? [])][0]?.terminate();
      await waitFor(
        () =>
          (connectionCounts.get("/failed-relay") ?? 0) >= 2 &&
          failedRelay.getHealth().state === "healthy",
      );
      expect(failedRelay.getHealth().generation).toBeGreaterThanOrEqual(2);
      expect(healthyRelay.getHealth()).toMatchObject({ state: "healthy", generation: 1 });
      expect(connectionCounts.get("/healthy-relay")).toBe(1);

      failedRelay.stop();
      healthyRelay.stop();
      const connectionsAtStop = [...connectionCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      for (const pathSockets of sockets.values()) {
        for (const socket of pathSockets) socket.terminate();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(failedRelay.getHealth().state).toBe("stopped");
      expect(healthyRelay.getHealth().state).toBe("stopped");
      expect([...connectionCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(
        connectionsAtStop,
      );
    } finally {
      failedRelay.stop();
      healthyRelay.stop();
      pool.destroy();
      for (const pathSockets of sockets.values()) {
        for (const socket of pathSockets) socket.terminate();
      }
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
