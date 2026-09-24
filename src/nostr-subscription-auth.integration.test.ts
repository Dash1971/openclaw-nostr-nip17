import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { WebSocketServer } from "ws";
import { startNostrBus } from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";

it.each([true, false])("handles prefixed subscription auth; accepted=%s", async (accept) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "nostr-prefixed-auth-"));
  setNostrRuntime({ state: { resolveStateDir: () => stateDir } } as never);
  const key = generateSecretKey();
  const server = createServer();
  const relay = new WebSocketServer({ server });
  let authCount = 0;
  const errors: string[] = [];
  relay.on("connection", (socket) => {
    let authenticated = false;
    socket.send(JSON.stringify(["AUTH", "synthetic-challenge"]));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message[0] === "EVENT") {
        socket.send(JSON.stringify(["OK", message[1].id, true, "accepted"]));
      }
      if (message[0] === "AUTH") {
        const event = message[1] as Event;
        expect(verifyEvent(event)).toBe(true);
        expect(event.kind).toBe(22242);
        expect(event.pubkey).toBe(getPublicKey(key));
        expect(event.tags).toContainEqual(["challenge", "synthetic-challenge"]);
        authCount++;
        authenticated = accept;
        socket.send(JSON.stringify(["OK", event.id, accept, accept ? "accepted" : "denied"]));
      }
      if (message[0] === "REQ") {
        socket.send(JSON.stringify(authenticated
          ? ["EOSE", message[1]]
          : ["CLOSED", message[1], "ERROR: auth-required: requested filter requires authentication"]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local relay address");
  const bus = await startNostrBus({ accountId: "fixture", privateKey: Buffer.from(key).toString("hex"),
    relays: [`ws://127.0.0.1:${address.port}`], onMessage: async () => {},
    onError: (error) => errors.push(error.message),
  });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (accept ? bus.getHealth().connectedRelays !== 1 : !errors.includes("denied"))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(authCount).toBeGreaterThan(0);
    expect(bus.getHealth().connectedRelays).toBe(accept ? 1 : 0);
    if (!accept) expect(errors).toContain("denied");
  } finally {
    await bus.close();
    expect(bus.getHealth().state).toBe("stopped");
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 10000);
