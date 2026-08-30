import { getEventHash, verifyEvent, type Event } from "nostr-tools";
import { v2 as nip44 } from "nostr-tools/nip44";
import { wrapEvent } from "nostr-tools/nip17";

export const NIP17_GIFT_WRAP_KIND = 1059;
export const NIP17_SEAL_KIND = 13;
export const NIP17_DM_KIND = 14;
export const NIP17_INBOX_RELAYS_KIND = 10050;

export interface UnwrappedNip17Message {
  senderPubkey: string;
  content: string;
  createdAt: number;
  rumorId: string;
}

function decryptJson<T>(event: Pick<Event, "content" | "pubkey">, privateKey: Uint8Array): T {
  const conversationKey = nip44.utils.getConversationKey(privateKey, event.pubkey);
  return JSON.parse(nip44.decrypt(event.content, conversationKey)) as T;
}

export function unwrapNip17Message(
  giftWrap: Event,
  recipientPrivateKey: Uint8Array,
  recipientPubkey: string,
): UnwrappedNip17Message {
  if (giftWrap.kind !== NIP17_GIFT_WRAP_KIND || !verifyEvent(giftWrap)) {
    throw new Error("Invalid NIP-17 gift wrap");
  }
  if (!giftWrap.tags.some((tag) => tag[0] === "p" && tag[1] === recipientPubkey)) {
    throw new Error("NIP-17 gift wrap is not addressed to this account");
  }

  const seal = decryptJson<Event>(giftWrap, recipientPrivateKey);
  if (seal.kind !== NIP17_SEAL_KIND || !verifyEvent(seal)) {
    throw new Error("Invalid NIP-17 seal");
  }

  const rumor = decryptJson<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  }>(seal, recipientPrivateKey);

  if (rumor.kind !== NIP17_DM_KIND) {
    throw new Error("Unsupported NIP-17 rumor kind");
  }
  if (rumor.pubkey !== seal.pubkey || rumor.id !== getEventHash(rumor)) {
    throw new Error("NIP-17 rumor integrity check failed");
  }
  if (!rumor.tags.some((tag) => tag[0] === "p" && tag[1] === recipientPubkey)) {
    throw new Error("NIP-17 rumor is not addressed to this account");
  }
  if (typeof rumor.content !== "string" || typeof rumor.created_at !== "number") {
    throw new Error("Malformed NIP-17 rumor");
  }

  return {
    senderPubkey: rumor.pubkey,
    content: rumor.content,
    createdAt: rumor.created_at,
    rumorId: rumor.id,
  };
}

export function createNip17Message(
  senderPrivateKey: Uint8Array,
  recipientPubkey: string,
  content: string,
  replyToEventId?: string,
): Event {
  return wrapEvent(
    senderPrivateKey,
    { publicKey: recipientPubkey },
    content,
    undefined,
    replyToEventId ? { eventId: replyToEventId } : undefined,
  );
}

export function readInboxRelays(event: Event | null | undefined): string[] {
  if (!event || event.kind !== NIP17_INBOX_RELAYS_KIND) {
    return [];
  }
  return [
    ...new Set(
      event.tags
        .filter((tag) => tag[0] === "relay" && typeof tag[1] === "string")
        .map((tag) => tag[1].trim())
        .filter((relay) => relay.startsWith("wss://")),
    ),
  ];
}
