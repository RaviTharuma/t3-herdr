#!/usr/bin/env node
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
if (!command.length) throw new Error("usage: t3-herdr-runner -- command");
const supervisorPath = fileURLToPath(new URL("./supervisor.js", import.meta.url));
const sourceSupervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
const supervisor = fork(
  import.meta.url.endsWith(".ts") ? sourceSupervisorPath : supervisorPath,
  [],
  {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, T3_HERDR_COMMAND: JSON.stringify(command) },
  },
);
const exited = once(supervisor, "exit").then(() => undefined);
await Promise.race([
  new Promise<void>((resolve, reject) =>
    supervisor.once("message", (value) => {
      if (
        value &&
        typeof value === "object" &&
        "version" in value &&
        value.version === 1 &&
        "type" in value &&
        value.type === "started"
      )
        resolve();
      else reject(new Error("invalid supervisor protocol"));
    }),
  ),
  once(supervisor, "error").then(([error]) => Promise.reject(error)),
  exited.then(() => Promise.reject(new Error("supervisor exited before start"))),
]);
await Promise.race([
  new Promise<void>((resolve) =>
    supervisor.on("message", (value) => {
      if (
        value &&
        typeof value === "object" &&
        "version" in value &&
        value.version === 1 &&
        "type" in value &&
        value.type === "completed"
      )
        resolve();
    }),
  ),
  once(supervisor, "error").then(([error]) => Promise.reject(error)),
  exited,
]);
supervisor.removeAllListeners("message");
if (supervisor.connected) supervisor.disconnect();
supervisor.channel?.unref?.();
supervisor.unref();
