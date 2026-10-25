# t3-plugin-herdr

`t3-herdr` is a Linux x64, foreground-only whole-environment host for compatible T3 builds. It launches T3 process hosts in Herdr panes while retaining T3's native provider behavior. The controller uses a private local Unix socket to associate a runner with one persisted launch generation.

## Requirements

Follow the fleet-wide guidance in `~/.agents/README.md` when it exists.

- Linux x64.
- Bun 1.3 or newer.
- A T3 build that implements environment-host protocol 1, accepts `--json` for `host capabilities` and `host status`, and reports `protocolVersion: 1` with `protectedSecretFile: true`.
- Herdr with its Unix control socket available.
- `XDG_RUNTIME_DIR` set to a private runtime directory. There is no home-directory socket fallback.
- `XDG_STATE_HOME` is optional; `$HOME/.local/state` is the XDG default.

## Install

From the package registry:

```sh
bun add --global t3-herdr
```

For a one-off invocation without a global install:

```sh
bunx --package t3-herdr t3-herdr --help
```

Associate the installed host with a compatible T3 checkout:

```sh
t3-herdr install --t3 /path/to/t3 --base-dir /path/to/t3-state
t3-herdr status --t3 /path/to/t3 --base-dir /path/to/t3-state
t3-herdr diagnose --t3 /path/to/t3 --base-dir /path/to/t3-state
t3-herdr disable --t3 /path/to/t3 --base-dir /path/to/t3-state
```

For source development, run `bun run build` and replace `t3-herdr` above with `./dist/cli.js`.

Installation creates a 256-bit association secret in a package-owned mode-0600 XDG state file before invoking T3's trusted `host install` surface. The secret never appears in argv, output, or logs. Failed or incompatible installation is refused and transactionally disables T3 before removing newly created association artifacts. `disable` first verifies direct mode, then removes the package-owned association and secret when no live generation remains.

Update with `bun update --global t3-herdr`. Before uninstalling, run `t3-herdr disable` for every associated T3 base directory so package-owned secrets are removed, then run `bun remove --global t3-herdr`.

## Operation

At startup, the registry is loaded and the controller creates `$XDG_RUNTIME_DIR/t3-herdr/control.sock` with mode `0600` in a mode `0700` directory. A launch is persisted before Herdr opens its pane. The runner authenticates with the launch ID and generation token, then relays bounded newline-delimited frames for stdin, stdout, stderr, exit status, and the final cleanup receipt.

`HOME`, `PATH`, and workload variables are preserved. Herdr targeting variables are removed before private `T3_HERDR_*` association variables are added.

Cancellation and controller loss send `SIGTERM` to the owned process group and escalate to `SIGKILL`. Output drains before exit and cleanup frames. Failed launches are durable and retry with a new generation and token; a pane opened before persistence failure is closed as rollback.

The managed bridge exposes `sendStdin`/`writeStdin`, `endStdin`, consumable async `stdout` and `stderr` streams, `started`, `exited`, `closed`, and `completed` promises, plus `cancel`/`stop`. Output queues are byte-bounded and release memory as consumers advance; output history is not retained. Protocol order is strict (`expected`, `hello`, `started`, `exited`, `cleaned`/`closed`) and every terminal path settles all lifecycle promises.

## Scope

This release is Linux x64 only and runs in the foreground. Each workload runs in an owned process session; cancellation and controller loss terminate the complete owned process group with TERM then KILL. It does not install a service, daemonize, provide remote multi-machine transport, pool processes, or claim desktop/provider parity.

## Verification and publication

Run `bun run check`. `bun pm pack` invokes `prepack`, repeating type checking, tests, and the native-host build. The package contains only `package.json`, this README, and `dist`; `package.json` restricts installation to Linux x64 and exposes the CLI, runner, and native host binaries.

```toon
format: toon
version: 4.4
project: t3-herdr
status: foreground Linux x64 release candidate
transport: private Unix socket
publication: prepack verified
```
