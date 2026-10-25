# HANDOFF

Follow the fleet-wide guidance in `~/.agents/HANDOFF.md` when it exists. This repository-specific file records only t3-herdr requirements.

```toon
format: toon
version: 4.4
project: t3-herdr
status: initial vertical slice
```

```toon
managedHostedBridge:
  status: implemented
  api: live streams and lifecycle promises
  verification: pending final commands
```

## Current status

```toon
status: implemented and locally verified
tests: 35 passing
tracker: bd init blocked by central server mode mismatch; incomplete artifacts removed
next: validate against a live Herdr workspace; packed-artifact lifecycle is verified
gotchas: foreground Linux slice only; no service, desktop, provider, or remote parity claimed
```

## Installable T3 host milestone

```toon
status: implemented and verified
commands: [install, status, disable, diagnose]
contract: T3 environment-host protocol 1 with protected secret-file install
safety: no global install, no production mutation, disable preserves artifacts and receipts
```
