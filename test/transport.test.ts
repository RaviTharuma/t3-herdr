import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { FrameDecoder, decodeBytes, encodeBytes, encodeFrame, writeFrame } from "../src/protocol";
import { listenPrivate } from "../src/rendezvous";
import { ControllerSession, ControllerTransport } from "../src/controller";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function createDirectory() { const path = await mkdtemp(join(tmpdir(), "t3-herdr-transport-")); directories.push(path); return path; }

function decodeFrames(bytes: Buffer) { const decoder = new FrameDecoder(); const frames = decoder.push(bytes); decoder.end(); return frames; }

describe("strict protocol", () => {
  test("rejects malformed schemas and non-canonical base64", () => {
    const malformed = [
      { type: "hello", launchId: "a", token: "t", extra: true },
      { type: "start", launchId: "" },
      { type: "data", stream: "stdout", bytes: "!!!!" },
      { type: "exit", code: 1.5, signal: null },
      { type: "unknown" },
    ];
    for (const frame of malformed) expect(() => decodeFrames(Buffer.from(`${JSON.stringify(frame)}\n`))).toThrow();
    expect(() => decodeBytes("YQ")).toThrow("base64");
  });

  test("applies the limit to each frame while permitting batches", () => {
    const frame = encodeFrame({ type: "start", launchId: "12345678" });
    const decoder = new FrameDecoder(frame.length);
    expect(decoder.push(Buffer.concat([frame, frame]))).toHaveLength(2);
    expect(() => new FrameDecoder(frame.length - 1).push(frame)).toThrow("limit");
  });

  test("serializes bounded writes under backpressure", async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    let bytes = Buffer.alloc(0);
    output.on('data', chunk => { output.pause(); setTimeout(() => { bytes = Buffer.concat([bytes, chunk]); output.resume(); }, 2); });
    await Promise.all([
      writeFrame(output, { type: "data", stream: "stdout", bytes: encodeBytes(Buffer.from("first")) }),
      writeFrame(output, { type: "data", stream: "stderr", bytes: encodeBytes(Buffer.from("second")) }),
    ]);
    output.end(); await once(output, "end");
    expect(decodeFrames(bytes).map(frame => frame.type === "data" ? decodeBytes(frame.bytes).toString() : "")).toEqual(["first", "second"]);
  });
});

describe("private controller and real runner", () => {
  test("authenticates association and relays binary streams through final exit drain", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "control.sock");
    const transport = new ControllerTransport(socketPath, { maxBufferedBytes: 64 * 1024 });
    const server = await transport.listen(); expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const session = transport.expect({ launchId: "binary", token: "secret" });
    const child = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", "process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(Buffer.from([0,255]));process.exit(7)})"], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "binary", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    const collect = async (stream: AsyncIterable<Buffer>) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
    const stdout = collect(session.stdout); const stderr = collect(session.stderr); const childExit = once(child, "exit"); await session.started; await session.sendStdin(Buffer.from([0, 10, 255])); await session.endStdin();
    const result = await session.completed;
    expect(await stdout).toEqual(Buffer.from([0, 10, 255])); expect(await stderr).toEqual(Buffer.from([0, 255])); expect(result.exit).toEqual({ code: 7, signal: null }); expect(result.cleanup).toEqual({ launchId: "binary", token: "secret" });
    expect([0, null]).toContain((await childExit)[0]); await transport.close(); expect(server.listening).toBe(false);
  });

  test("rejects unauthenticated starts and malformed batches", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "control.sock"); const transport = new ControllerTransport(socketPath); await transport.listen(); transport.expect({ launchId: "good", token: "secret" });
    const socket = createConnection(socketPath); await once(socket, "connect"); socket.write(Buffer.concat([encodeFrame({ type: "hello", launchId: "good", token: "wrong" }), encodeFrame({ type: "start", launchId: "good" })]));
    await once(socket, "close"); expect(transport.pendingCount).toBe(1); await transport.close();
  });

  test("graceful transport close stops a SIGTERM-resistant child", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "graceful-close.sock");
    const transport = new ControllerTransport(socketPath); await transport.listen(); const session = transport.expect({ launchId: "graceful-close", token: "secret" });
    const runner = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "graceful-close", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    const runnerExit = once(runner, "exit"); await session.started; await transport.close(); await session.completed;
    await Promise.race([runnerExit, Bun.sleep(3000).then(() => { runner.kill("SIGKILL"); throw new Error("runner did not exit after graceful close"); })]);
    expect(await Bun.file(socketPath).exists()).toBe(false);
  }, 10_000);

  test("abrupt transport abort stops a SIGTERM-resistant child", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "abrupt-abort.sock");
    const transport = new ControllerTransport(socketPath); await transport.listen(); const session = transport.expect({ launchId: "abrupt-abort", token: "secret" });
    const runner = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "abrupt-abort", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    const runnerExit = once(runner, "exit"); await session.started; const ready = await session.stdout[Symbol.asyncIterator]().next(); expect(ready.value?.toString()).toBe("ready");
    const completion = session.completed; await Promise.race([transport.abort(), Bun.sleep(3000).then(() => { throw new Error("transport abort did not finish"); })]); await expect(completion).rejects.toThrow("closed");
    await Promise.race([runnerExit, Bun.sleep(3000).then(() => { runner.kill("SIGKILL"); throw new Error("runner did not exit after abrupt abort"); })]);
    expect(await Bun.file(socketPath).exists()).toBe(false);
  }, 10_000);


  test("kills the child when the runner is killed", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "runner-loss.sock"); const pidPath = join(directory, "child.pid");
    const transport = new ControllerTransport(socketPath); await transport.listen(); const session = transport.expect({ launchId: "runner-loss", token: "secret" });
    const script = `require("fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
    const runner = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", script], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "runner-loss", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    await session.started; while (!await Bun.file(pidPath).exists()) await Bun.sleep(10); const childPid = Number(await readFile(pidPath, "utf8"));
    runner.kill("SIGKILL"); await once(runner, "exit");
    for (let attempt=0; attempt<200; attempt++) { try { process.kill(childPid, 0); await Bun.sleep(10); } catch { break; } }
    expect(() => process.kill(childPid, 0)).toThrow(); await transport.close();
  }, 10_000);

  test("runner loss cleans its detached workload process group including a grandchild", async () => {
    const directory = await createDirectory();
    const socketPath = join(directory, "grandchild-loss.sock");
    const pidPath = join(directory, "processes.json");
    const transport = new ControllerTransport(socketPath);
    await transport.listen();
    const session = transport.expect({ launchId: "grandchild-loss", token: "secret" });
    const script = `const{spawn}=require("child_process"),fs=require("fs");const grandchild=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,grandchild:grandchild.pid}));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
    const runner = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", script], {
      env: { ...process.env, T3_HERDR_LAUNCH_ID: "grandchild-loss", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath },
      stdio: ["ignore", "ignore", "inherit"],
    });
    await session.started;
    while (!(await Bun.file(pidPath).exists())) await Bun.sleep(10);
    const pids = JSON.parse(await readFile(pidPath, "utf8")) as { parent: number; grandchild: number };
    runner.kill("SIGKILL");
    await once(runner, "exit");
    for (const pid of [pids.parent, pids.grandchild]) {
      for (let attempt = 0; attempt < 300; attempt++) {
        try { process.kill(pid, 0); await Bun.sleep(10); } catch { break; }
      }
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await transport.close();
  }, 10_000);
});


describe("controller lifecycle invariants", () => {
  const association = { launchId: "phase", token: "secret" };
  const exit = { type: "exit", code: 0, signal: null } as const;
  const cleanup = { type: "cleanup", ...association } as const;

  test("rejects start and completion when output arrives before start", async () => {
    const session = new ControllerSession(association, 8);
    session.hello();
    expect(() => session.receive({ type: "data", stream: "stdout", bytes: encodeBytes(Buffer.from("x")) })).toThrow("unexpected");
    await expect(session.started).rejects.toThrow("unexpected");
    await expect(session.completed).rejects.toThrow("unexpected");
  });

  test("rejects duplicate start and output after exit", async () => {
    for (const invalid of [{ type: "start", launchId: "phase" } as const, { type: "data", stream: "stdout", bytes: encodeBytes(Buffer.from("x")) } as const]) {
      const session = new ControllerSession(association, 8);
      session.hello(); session.start();
      if (invalid.type === "data") session.receive(exit);
      expect(() => session.receive(invalid)).toThrow("unexpected");
      await expect(session.completed).rejects.toThrow("unexpected");
    }
  });

  test("settles both promises on close before start and controller loss after start", async () => {
    const early = new ControllerSession(association, 8); early.close(new Error("closed"));
    await expect(early.started).rejects.toThrow("closed"); await expect(early.completed).rejects.toThrow("closed");
    const active = new ControllerSession(association, 8); active.hello(); active.start(); active.close(new Error("lost"));
    await expect(active.started).resolves.toBeUndefined(); await expect(active.completed).rejects.toThrow("lost");
  });

  test("replacement revoke and shutdown settle old expectations", async () => {
    const directory = await createDirectory(); const transport = new ControllerTransport(join(directory, "control.sock"));
    const old = transport.expect({ launchId: "same", token: "old" });
    const replacement = transport.expect({ launchId: "same", token: "new" });
    await expect(old.started).rejects.toThrow("replaced"); await expect(old.completed).rejects.toThrow("replaced");
    expect(transport.revoke("same")).toBe(true);
    await expect(replacement.started).rejects.toThrow("revoked"); await expect(replacement.completed).rejects.toThrow("revoked");
    const pending = transport.expect({ launchId: "pending", token: "token" }); await transport.close();
    await expect(pending.started).rejects.toThrow("closed"); await expect(pending.completed).rejects.toThrow("closed");
  });

  test("hello followed by disconnect clears the matching expectation and settles it", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "hello-disconnect.sock");
    const transport = new ControllerTransport(socketPath); await transport.listen();
    const session = transport.expect({ launchId: "hello-disconnect", token: "secret" });
    const socket = createConnection(socketPath); await once(socket, "connect");
    await writeFrame(socket, { type: "hello", launchId: "hello-disconnect", token: "secret" });
    while (session.phase === "expected") await Bun.sleep(1);
    socket.destroy(); await once(socket, "close");
    await expect(session.started).rejects.toThrow("closed");
    await expect(session.completed).rejects.toThrow("closed");
    expect(transport.pendingCount).toBe(0);
    await transport.close();
  });

  test("slow consumers apply credit backpressure and preserve ordered final drain", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "pressure.sock");
    const capacity = 16 * 1024; const transport = new ControllerTransport(socketPath, { maxBufferedBytes: capacity }); await transport.listen();
    const session = transport.expect({ launchId: "pressure", token: "secret" }); const total = capacity * 24;
    const script = `const n=${total};const b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=i%251;process.stdout.write(b);process.stderr.write(b);`;
    const child = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", script], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "pressure", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    await session.started;
    const stdoutIterator = session.stdout[Symbol.asyncIterator](); const stderrIterator = session.stderr[Symbol.asyncIterator]();
    const first = await Promise.all([stdoutIterator.next(), stderrIterator.next()]);
    expect(first.every(({ done, value }) => !done && value.length > 0)).toBe(true); expect(session.bufferedBytes).toBeLessThanOrEqual(capacity); expect(session.phase).toBe("started");
    const consume = async (iterator: AsyncIterator<Buffer>, initial: IteratorResult<Buffer>) => { const chunks = initial.done ? [] : [initial.value]; for (;;) { const next = await iterator.next(); if (next.done) return Buffer.concat(chunks); chunks.push(next.value); } };
    const [stdout, stderr, result] = await Promise.all([consume(stdoutIterator, first[0]), consume(stderrIterator, first[1]), session.completed]);
    const expected = Buffer.alloc(total); for (let i=0;i<total;i++) expected[i]=i%251;
    expect(stdout).toEqual(expected); expect(stderr).toEqual(expected); expect(result.exit).toEqual({ code: 0, signal: null }); expect(session.peakBufferedBytes).toBeLessThanOrEqual(capacity);
    await once(child, "exit"); await transport.close();
  }, 15_000);

  test("shared credit makes bounded progress on both output streams", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "fair-pressure.sock");
    const capacity = 1024; const transport = new ControllerTransport(socketPath, { maxBufferedBytes: capacity }); await transport.listen();
    const session = transport.expect({ launchId: "fair-pressure", token: "secret" }); const total = 64 * 1024;
    const script = `const b=Buffer.alloc(1024,97);for(let n=0;n<${total}/b.length;n++){process.stdout.write(b);process.stderr.write(b)}`;
    const child = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", script], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "fair-pressure", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    await session.started;
    const stdout = session.stdout[Symbol.asyncIterator](); const stderr = session.stderr[Symbol.asyncIterator]();
    const first = await Promise.all([stdout.next(), stderr.next()]);
    expect(first.every(({ done, value }) => !done && value.length > 0)).toBe(true);
    const drain = async (iterator: AsyncIterator<Buffer>, initial: IteratorResult<Buffer>) => { const chunks = initial.done ? [] : [initial.value]; for (;;) { const next = await iterator.next(); if (next.done) return Buffer.concat(chunks); chunks.push(next.value); } };
    const [stdoutBytes, stderrBytes, result] = await Promise.all([drain(stdout, first[0]), drain(stderr, first[1]), session.completed]);
    expect(stdoutBytes.length).toBe(total); expect(stderrBytes.length).toBe(total); expect(result.exit).toEqual({ code: 0, signal: null }); expect(session.peakBufferedBytes).toBeLessThanOrEqual(capacity);
    await once(child, "exit"); await transport.close();
  }, 5_000);

  test("slow consumers drain output larger than 16 KiB with a 1 KiB window", async () => {
    const directory = await createDirectory(); const socketPath = join(directory, "small-window.sock");
    const capacity = 1024; const transport = new ControllerTransport(socketPath, { maxBufferedBytes: capacity }); await transport.listen();
    const session = transport.expect({ launchId: "small-window", token: "secret" }); const total = 20 * 1024 + 37;
    const script = `const n=${total};const b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=i%251;process.stdout.write(b);`;
    const child = spawn(process.execPath, [join(process.cwd(), "src/runner.ts"), "--", process.execPath, "-e", script], { env: { ...process.env, T3_HERDR_LAUNCH_ID: "small-window", T3_HERDR_TOKEN: "secret", T3_HERDR_SOCKET: socketPath }, stdio: ["ignore", "ignore", "inherit"] });
    await session.started;
    const chunks: Buffer[] = []; for await (const chunk of session.stdout) { chunks.push(chunk); await Bun.sleep(1); }
    const result = await session.completed; const expected = Buffer.alloc(total); for (let i=0;i<total;i++) expected[i]=i%251;
    expect(Buffer.concat(chunks)).toEqual(expected); expect(result.exit).toEqual({ code: 0, signal: null }); expect(session.peakBufferedBytes).toBeLessThanOrEqual(capacity);
    await once(child, "exit"); await transport.close();
  }, 15_000);
});
