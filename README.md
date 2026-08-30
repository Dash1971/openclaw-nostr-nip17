# OpenClaw Nostr NIP-17

An experimental, drop-in replacement for OpenClaw's official Nostr channel plugin that uses modern NIP-17 private direct messages instead of deprecated NIP-04 messages.

## Features

- NIP-17 private DMs (`kind:14` rumors inside NIP-59 gift wraps)
- NIP-44 v2 encryption
- Automatic NIP-17 inbox-relay advertisement (`kind:10050`)
- Recipient inbox-relay discovery before outbound delivery
- Gift-wrap signature, seal signature, rumor hash, sender, recipient, size, and rate-limit checks
- Existing OpenClaw DM policies: pairing, allowlist, open, or disabled
- Existing OpenClaw profile, metrics, retry, relay-health, and state-persistence support

## Compatibility

- OpenClaw 2026.7.1 or newer
- Nostr clients implementing NIP-17 and NIP-59

This package currently uses the same `nostr` channel ID as the official plugin, so disable the official `nostr` plugin before enabling this replacement.

## Install from GitHub

```bash
openclaw plugins install https://github.com/Dash1971/openclaw-nostr-nip17
openclaw plugins disable nostr
openclaw plugins enable nostr-nip17
```

Configure `channels.nostr` as documented by OpenClaw. Keep the private key in an environment variable or OpenClaw SecretRef; never commit it.

```json
{
  "channels": {
    "nostr": {
      "enabled": true,
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1..."]
    }
  }
}
```

Restart the gateway after changing plugins or secret environment variables.

### Optional TOTP step-up authentication

Set `channels.nostr.totpSecret` to a SecretRef containing an RFC 4648 base32 TOTP seed.
When configured, allowlisted senders must send `AUTH 123456` before any message reaches the
agent or command dispatcher. Authentication sessions default to five minutes and can be set
from 60 to 3600 seconds with `channels.nostr.totpSessionSeconds`.

TOTP codes are consumed before agent dispatch, are never intentionally logged, cannot be reused
for a second authentication in the same time step, and lock for five minutes after five failures.
Keep the TOTP seed separate from the Nostr signing key. TOTP reduces the impact of a stolen Nostr
key but does not restore message confidentiality or prevent a live attacker from sharing an
already-authenticated session.

## Security notes

- NIP-17 hides the sender and message type from public relay observers, but it does not provide forward secrecy or post-compromise security.
- The plugin decrypts the outer gift wrap before sender allowlist enforcement because NIP-17 deliberately hides the sender. Global ciphertext limits, relay-event signature verification, and global rate limiting run before decryption.
- Outbound delivery fails closed when the recipient has not published a valid `kind:10050` inbox-relay event.
- This is an early independent fork. Review and test it before relying on it for high-value secrets.

## Development

```bash
npm install
npm test
npm run typecheck
```

## Licence and attribution

MIT. This project is derived from OpenClaw's MIT-licensed official Nostr plugin. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
