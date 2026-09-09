# Public review guidelines

Use this repository for plugin development and reproducible technical review.

Appropriate public content:
- Source code, dependency versions, commit references, and technical findings.
- Synthetic identities, generated test keys, published protocol test vectors, and local mock relays.
- Minimal reproductions and clearly scoped test results.
- Generic installation and lifecycle requirements that do not describe a particular deployment.

Keep outside the repository and GitHub discussions:
- Hostnames, network addresses, remote-access usernames, SSH commands, and key paths.
- Actual credentials, signing keys, authentication seeds, tokens, and environment files.
- Real service definitions, privileged recovery commands, sudo rules, and machine filesystem layouts.
- Operational logs, message histories, incident timelines, private test destinations, and operator approval records.

Before posting, check the diff and any attachments. Use placeholders or synthetic fixtures rather than redacting a few values from a complete operational log.

Changing a file does not remove its previous contents from Git history, caches, forks, or existing clones. If a real credential is ever exposed, revoke or rotate it and handle history cleanup separately.

After a history rewrite, use a fresh clone or a carefully cleaned branch. Do not merge or push pre-rewrite branches back into the repository; doing so can restore removed history. Preserve uncommitted work privately before replacing a clone.
