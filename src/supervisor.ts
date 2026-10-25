import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { decodeBytes, encodeBytes, FrameDecoder, writeFrame } from "./protocol.js";

const commandText = process.env.T3_HERDR_COMMAND;
if (!commandText) throw new Error("supervisor command is required");
const command = JSON.parse(commandText) as string[];
if (!command.length) throw new Error("usage: t3-herdr-runner -- command");
const launchId = process.env.T3_HERDR_LAUNCH_ID;
const token = process.env.T3_HERDR_TOKEN;
const socketPath = process.env.T3_HERDR_SOCKET;
if (!launchId || !token || !socketPath) throw new Error("runner association is required");
for (const key of ["T3_HERDR_LAUNCH_ID", "T3_HERDR_TOKEN", "T3_HERDR_SOCKET", "T3_HERDR_COMMAND"])
  delete process.env[key];

const socket = createConnection(socketPath);
await Promise.race([
  once(socket, "connect"),
  once(socket, "error").then(([error]) => Promise.reject(error)),
]);
await writeFrame(socket, { type: "hello", launchId, token });
const child = spawn(command[0]!, command.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  detached: true,
});
const childClosed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
const outputEnded = [child.stdout, child.stderr].map((source) => new Promise<void>((resolve, reject) => {
  source.once("end", resolve);
  source.once("error", reject);
}));
await Promise.race([
  once(child, "spawn"),
  once(child, "error").then(([error]) => Promise.reject(error)),
]);
await writeFrame(socket, { type: "start", launchId });
if (process.send) process.send({ version: 1, type: "started" });

let isDisconnected = false;
let isTerminating = false;
let forceTimer: NodeJS.Timeout | undefined;
const waiting: Array<() => void> = [];
function signalChild(signal: NodeJS.Signals) {
  if (child.pid) process.kill(-child.pid, signal);
}
function terminate() {
  if (isTerminating || child.exitCode !== null || child.signalCode !== null) return;
  isTerminating = true;
  child.stdin.destroy();
  signalChild("SIGTERM");
  forceTimer = setTimeout(() => {
    if (child.pid && child.exitCode === null && child.signalCode === null)
      process.kill(-child.pid, "SIGKILL");
  }, 250);
}
function disconnect() {
  if (isDisconnected) return;
  isDisconnected = true;
  while (waiting.length) waiting.shift()!();
  terminate();
}

const decoder = new FrameDecoder();
socket.on("data", (chunk) => {
  try {
    for (const frame of decoder.push(Buffer.from(chunk))) {
      if (frame.type === "window") grant(frame.bytes);
      else if (frame.type === "data" && frame.stream === "stdin") {
        if (!child.stdin.write(decodeBytes(frame.bytes))) { socket.pause(); child.stdin.once("drain", () => socket.resume()); }
      } else if (frame.type === "eof") child.stdin.end();
      else if (frame.type === "cancel" && frame.launchId === launchId) terminate();
      else throw new Error("unexpected controller frame");
    }
  } catch {
    socket.destroy();
    disconnect();
  }
});
socket.once("end", disconnect);
socket.once("close", disconnect);
socket.once("error", disconnect);
process.once("disconnect", disconnect);

const outputs = [
  { stream: "stdout" as const, source: child.stdout, queue: [] as Buffer[], offset: 0 },
  { stream: "stderr" as const, source: child.stderr, queue: [] as Buffer[], offset: 0 },
];
let credit = 0;
let nextOutput = 0;
let pumpPromise: Promise<void> | undefined;
let pumpScheduled: Promise<void> | undefined;
function resumeEmptyOutputs() {
  if (credit <= 0 || isDisconnected) return;
  for (const output of outputs) if (!output.queue.length) output.source.resume();
}
function schedulePump() {
  if (pumpPromise || pumpScheduled || isDisconnected) return;
  pumpScheduled = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    pumpScheduled = undefined;
    if (isDisconnected) return;
    pumpPromise = pump().finally(() => {
      pumpPromise = undefined;
      resumeEmptyOutputs();
      if (credit > 0 && outputs.some(({ queue }) => queue.length)) schedulePump();
    });
    void pumpPromise.catch(disconnect);
    return pumpPromise;
  });
  void pumpScheduled.catch(disconnect);
}
function grant(bytes: number) {
  credit += bytes;
  schedulePump();
  resumeEmptyOutputs();
}
async function pump() {
  while (credit > 0 && !isDisconnected) {
    let selected = -1;
    for (let count = 0; count < outputs.length; count++) {
      const index = (nextOutput + count) % outputs.length;
      if (outputs[index]!.queue.length) { selected = index; break; }
    }
    if (selected < 0) return;
    const output = outputs[selected]!;
    nextOutput = (selected + 1) % outputs.length;
    const bytes = output.queue[0]!;
    const length = Math.min(credit, 16 * 1024, bytes.length - output.offset);
    const part = bytes.subarray(output.offset, output.offset + length);
    credit -= length;
    output.offset += length;
    await writeFrame(socket, { type: "data", stream: output.stream, bytes: encodeBytes(part) });
    if (output.offset === bytes.length) {
      output.queue.shift();
      output.offset = 0;
      if (!output.queue.length && credit > 0) output.source.resume();
    }
  }
}
for (const output of outputs) {
  output.source.pause();
  output.source.on("data", (bytes) => {
    output.source.pause();
    output.queue.push(Buffer.from(bytes));
    schedulePump();
  });
}
const sources = outputs.map(({ source }) => source);

const [code, signal] = await childClosed;
if (forceTimer) clearTimeout(forceTimer);
child.stdin.destroy();
await Promise.all(outputEnded);
if (pumpPromise) await pumpPromise;
if (isDisconnected) {
  socket.destroy();
  await Promise.race([
    pumpPromise?.catch(() => undefined) ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
} else if (!socket.destroyed) {
  while (outputs.some(({ queue }) => queue.length)) {
    if (pumpScheduled) await pumpScheduled;
    else if (pumpPromise) await pumpPromise;
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await writeFrame(socket, { type: "exit", code, signal });
  await writeFrame(socket, { type: "cleanup", launchId, token });
  socket.end();
  if (!socket.destroyed) await once(socket, "close");
}
if (process.send) process.send({ version: 1, type: "completed" });
if (process.connected) process.disconnect?.();
