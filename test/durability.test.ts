import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry";
import { ControllerTransport } from "../src/controller";
import { LaunchCoordinator } from "../src/coordinator";
import { UnixHerdrClient } from "../src/herdr";

const setup = async (herdr?: any) => {
  const directory = await mkdtemp(join(tmpdir(), "bbh-"));
  const registry = new Registry(join(directory, "registry.json"));
  await registry.load();
  const calls: any[] = [];
  const client = herdr ?? {
    openPane: async (...args: any[]) => { calls.push(["open", ...args]); return "pane-1"; },
    closePane: async (id: string) => { calls.push(["close", id]); },
  };
  return { directory, registry, calls, coordinator: new LaunchCoordinator(registry, client, "runner", join(directory, "socket"), new ControllerTransport(join(directory, "control"))) };
};

async function socketServer(reply: (socket: import("node:net").Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "bbh-socket-"));
  const path = join(directory, "herdr.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); reply(socket); });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

describe("launch durability", () => {
  test("records launch failure and retries with a new generation and fence", async () => {
    let attempts = 0;
    const herdr = { openPane: async () => { if (++attempts === 1) throw new Error("launch failed"); return "pane-2"; }, closePane: async () => {} };
    const subject = await setup(herdr);
    await expect(subject.coordinator.launch({ launchId: "a", command: ["x"], cwd: "/tmp" })).rejects.toThrow("launch failed");
    const failed = subject.registry.get("a")!;
    expect(failed.state).toBe("failed");
    expect(failed.generation).toBe(1);
    const retried = await subject.coordinator.launch({ launchId: "a", command: ["x"], cwd: "/tmp" });
    expect(subject.registry.get("a")?.generation).toBe(2);
    expect(retried.association.token).not.toBe(failed.token);
    await expect(subject.coordinator.cleanup("a", failed.token)).rejects.toThrow("stale");
  });

  test("closes an opened pane when ready-state persistence fails", async () => {
    const subject = await setup();
    const originalPut = subject.registry.put.bind(subject.registry);
    let writes = 0;
    subject.registry.put = async (record) => {
      writes++;
      if (writes === 2) throw new Error("persist failed");
      return originalPut(record);
    };
    await expect(subject.coordinator.launch({ launchId: "a", command: ["x"], cwd: "/tmp" })).rejects.toThrow("persist failed");
    expect(subject.calls).toContainEqual(["close", "pane-1"]);
    expect(subject.registry.get("a")?.state).toBe("failed");
  });

  test("does not expose a registry mutation when persistence fails", async () => {
    const subject = await setup();
    await subject.registry.put({ launchId: "a", token: "old", generation: 1, state: "failed", started: false });
    const target = subject.registry.path;
    Object.defineProperty(subject.registry, "path", { value: join(target, "missing", "registry.json") });
    await expect(subject.registry.put({ launchId: "a", token: "new", generation: 2, state: "launching", started: false })).rejects.toThrow();
    expect(subject.registry.get("a")?.token).toBe("old");
  });

  test("unknown cleanup is harmless but stale cleanup is fenced", async () => {
    const subject = await setup();
    const record = await subject.coordinator.launch({ launchId: "a", command: ["x"], cwd: "/tmp" });
    expect(await subject.coordinator.cleanup("missing", record.token)).toBe(false);
    await expect(subject.coordinator.cleanup("a", "old-token")).rejects.toThrow("stale");
  });

  test("preserves PATH and HOME while stripping only Herdr targeting variables", async () => {
    const subject = await setup();
    await subject.coordinator.launch({ launchId: "a", command: ["x"], cwd: "/tmp", env: { HOME: "/home/user", PATH: "/bin", HERDR_SOCKET: "wrong", HERDR_WORKSPACE_ID: "wrong", KEEP: "yes" } });
    expect(subject.calls[0][3]).toMatchObject({ HOME: "/home/user", PATH: "/bin", KEEP: "yes" });
    expect(subject.calls[0][3].HERDR_SOCKET).toBeUndefined();
    expect(subject.calls[0][3].HERDR_WORKSPACE_ID).toBeUndefined();
  });
});

describe("Herdr response validation", () => {
  test("times out an unresponsive Herdr socket", async () => {
    const server = await socketServer(() => {});
    try { await expect(new UnixHerdrClient(server.path, { timeoutMs: 20 }).openPane(["x"], "/tmp", {})).rejects.toThrow("timed out"); }
    finally { await server.close(); }
  });

  test("rejects oversized responses", async () => {
    const server = await socketServer((socket) => socket.end("x".repeat(65)));
    try { await expect(new UnixHerdrClient(server.path, { maxResponseBytes: 64 }).openPane(["x"], "/tmp", {})).rejects.toThrow("too large"); }
    finally { await server.close(); }
  });

  test("rejects malformed pane responses", async () => {
    const server = await socketServer((socket) => socket.end(JSON.stringify({ result: {} })));
    try { await expect(new UnixHerdrClient(server.path).openPane(["x"], "/tmp", {})).rejects.toThrow("pane_id"); }
    finally { await server.close(); }
  });
});
