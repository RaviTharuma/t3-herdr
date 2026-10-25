# ARCHITECTURE

Follow the fleet-wide guidance in `~/.agents/ARCHITECTURE.md` when it exists. This repository-specific file records only t3-herdr requirements.

```toon
format: toon
version: 4.4
project: t3-herdr
status: initial vertical slice
```

## Language boundary

All T3-facing contracts, plugin behavior, Herdr orchestration, transport framing, state, and UI are strict TypeScript/TSX. The initial shim and runner are TypeScript. A native Rust helper is permitted only behind the versioned local protocol when platform failure tests demonstrate a supervision capability gap; its authority is limited to process containment and cleanup evidence.

```toon
languageBoundary:
  typescript: [T3 contract, plugin, Herdr client, protocol, state, UI, runner, shim]
  rust: [conditional process containment, conditional cleanup receipt]
  excludedFromRust: [provider semantics, conversations, approvals, recovery, workspace policy]
```

## Hosted process lifecycle

The registry is an internal durable fence and transaction journal. Public launches return a live `ManagedHostedBridge`. Expectation registration is part of the launch transaction: pane creation or persistence failure revokes the expectation, closes an owned pane, and records failure. Runner output uses serialized, drain-aware writes with a bounded pending-byte window; controller streams use bounded consumable queues.
