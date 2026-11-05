# Agent guide

## Purpose and structure

This npm-workspaces repository provides Pi permission review and execution isolation. Read the root README and the affected package README before editing.

- `packages/pi-auto-review/src/review/`: model calls, retained context, configuration and reviewer conversations.
- `packages/pi-auto-review/src/broker/`: decisions, exact grants, retries and denial rules.
- `packages/pi-auto-review/src/index.ts`: permission-system integration; `user-feedback.ts`: status cards and final decision reasons.
- `packages/pi-sandbox/`: inner shell isolation and network approval requests.
- `packages/pi-reviewed-escalation/`: exact-command escalation; `pi-statusline/`: independent display extension.

## Design constraints

Automatic mode never asks a human for permission. Review failures block the operation and return an actionable reason to the agent; a fresh review can be retried. Explicit denials and hard restrictions must not be bypassed. Interactive mode explicitly enables human fallback. Current defaults are 32,768 output tokens and low reasoning.

Compaction and internal bookkeeping must not invalidate a review. Preserve original user instructions; new/edited instructions, branch or session changes still require a fresh review. Grants remain bound to the exact operation. Keep project overrides narrower than trusted configuration. A final permission event ends the pending display; never leave “reviewing” visible after denial, or invent a reason missing from the event. Preserve the reviewer rationale when available.

The consumer launcher owns its tool allowlist. Question tools can be allowed there; do not broadly exempt unknown tools in this broker. Container escalation remains inside the container and does not bypass its network gateway or credential isolation.

## Tests and updates

Use Node >=22.19 and npm 11. Install with `npm ci`; run `npm run check` and `npm test`. For a focused change: `npm run test --workspace=@erichll/pi-auto-review` (other package names are in their package.json). Tests live beside each package. Linux OS sandbox tests need bubblewrap, socat and ripgrep; report platform skips accurately. Fixtures are not live model tests.

Do not use real credentials, transcripts or user containers in tests. Keep source and tests here, rather than patching copies in consumers. Local AI Sandboxes consumes a published commit and SHA-256-verified archive through its `containers/dev/security/sources.json`; update that pin and run its integration checks after publishing a runtime change. The standalone launcher is https://github.com/kyuz0/local-ai-sandboxes.

Keep documentation public-facing, concise and about supported behavior. Inspect diffs for private state before committing. Do not publish npm packages unless explicitly requested.
