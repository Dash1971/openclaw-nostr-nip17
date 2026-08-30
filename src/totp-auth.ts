import { createHmac, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

type SenderState = {
  authenticatedUntilMs: number;
  failures: number;
  lockedUntilMs: number;
};

export type TotpAuthResult =
  | { decision: "allow" }
  | { decision: "consume"; reply: string };

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("TOTP secret must be RFC 4648 base32");
  }
  let bits = "";
  for (const char of normalized) {
    const code = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += code.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  if (bytes.length < 10) {
    throw new Error("TOTP secret must contain at least 80 bits");
  }
  return Buffer.from(bytes);
}

function tokenForCounter(secret: Buffer, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTotpAuthenticator(options: {
  secret: string;
  sessionSeconds?: number;
  now?: () => number;
}) {
  const secret = decodeBase32(options.secret);
  const sessionMs = Math.min(3600, Math.max(60, options.sessionSeconds ?? 300)) * 1000;
  const sessionMinutes = Math.ceil(sessionMs / 60_000);
  const now = options.now ?? Date.now;
  const senderState = new Map<string, SenderState>();
  const usedCounters = new Set<number>();

  const authenticate = (senderPubkey: string, body: string): TotpAuthResult => {
    const nowMs = now();
    const state = senderState.get(senderPubkey) ?? {
      authenticatedUntilMs: 0,
      failures: 0,
      lockedUntilMs: 0,
    };
    senderState.set(senderPubkey, state);

    const match = /^AUTH\s+(\d{6})$/i.exec(body.trim());
    if (state.authenticatedUntilMs > nowMs) {
      return match
        ? { decision: "consume", reply: "Already authenticated." }
        : { decision: "allow" };
    }
    if (state.lockedUntilMs > nowMs) {
      return { decision: "consume", reply: "Authentication temporarily locked. Try again later." };
    }

    if (!match) {
      return {
        decision: "consume",
        reply: "Authentication required. Send exactly: AUTH followed by your current 6-digit code.",
      };
    }

    const token = match[1]!;
    const currentCounter = Math.floor(nowMs / 1000 / STEP_SECONDS);
    let acceptedCounter: number | null = null;
    for (const counter of [currentCounter - 1, currentCounter, currentCounter + 1]) {
      if (!usedCounters.has(counter) && tokensEqual(tokenForCounter(secret, counter), token)) {
        acceptedCounter = counter;
      }
    }

    if (acceptedCounter === null) {
      state.failures += 1;
      if (state.failures >= MAX_FAILURES) {
        state.failures = 0;
        state.lockedUntilMs = nowMs + LOCKOUT_MS;
      }
      return { decision: "consume", reply: "Authentication failed." };
    }

    usedCounters.add(acceptedCounter);
    for (const counter of usedCounters) {
      if (counter < currentCounter - 2) usedCounters.delete(counter);
    }
    state.failures = 0;
    state.lockedUntilMs = 0;
    state.authenticatedUntilMs = nowMs + sessionMs;
    return {
      decision: "consume",
      reply: `Authenticated for ${sessionMinutes} minute${sessionMinutes === 1 ? "" : "s"}.`,
    };
  };

  return { authenticate };
}
