# DECISIONS

Follow the fleet-wide guidance in `~/.agents/DECISIONS.md` when it exists. This repository-specific file records only t3-herdr requirements.

```toon
format: toon
version: 4.4
project: t3-herdr
status: initial vertical slice
```

## 2026-10-25 — TypeScript first, Rust only for proven supervision gaps

The generic T3 extension and t3-herdr plugin use strict TypeScript and TSX, following T3's SDK, UI, build, and runtime conventions. The transport shim and runner also begin in TypeScript.

A narrowly scoped Rust helper may be introduced only when failure-injection tests on a supported platform prove that T3's existing process utilities and Node cannot provide the required process ownership, termination, or cleanup receipt. Such a helper stays behind a versioned local protocol and may own only process launch, streams, containment, termination, and cleanup evidence. It does not own provider selection, permissions, conversations, approvals, recovery, or Herdr workspace policy.

A Rust implementation is not itself cleanup proof; every platform must pass the same lifecycle and crash tests before certification.

```toon
languageDecision:
  primary: TypeScript
  ui: TSX
  nativeHelper: conditional Rust
  rustGate: measured supervision failure
  protocol: versioned local IPC
```

```toon
- date: 2026-10-25
  decision: Public hosted launches return ManagedHostedBridge while registry records remain internal.
- date: 2026-10-25
  decision: Hosted output is consumable and byte-bounded with producer backpressure; history is not retained.
```

## 2026-10-25

```toon
decisions[4]:
  - strict TypeScript and Bun match T3
  - Herdr layout.apply creates one inert runner pane under actor T3
  - exact T3 argv is vp run dev:desktop from the configured checkout root
  - controller association secrets remain environment-only and are removed before spawning T3
```

## 2026-10-25 — Fail closed on protected T3 installation

```toon
- The installer requires protocol 1 JSON capabilities with `protectedSecretFile: true`.
- Association secrets are 256-bit random values and never appear in argv or logs.
- Disable delegates to T3 and preserves package artifacts and association receipts.
```
