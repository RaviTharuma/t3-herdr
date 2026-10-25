import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const HOST_PROTOCOL_VERSION = 1;
export type HostStatus = {
  protocolVersion: 1;
  mode: "direct" | "required";
  protectedSecretFile: true;
  executable?: string;
  revision?: string;
};
type Capabilities = { protocolVersion: 1; protectedSecretFile: true };
type Association = { protocolVersion: 1; baseDir: string; secretFile: string };

type CommandEnvironment = NodeJS.ProcessEnv;

function run(command: string, args: string[], env: CommandEnvironment) {
  return new Promise<{ stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)),
    );
  });
}

function parseObject(stdout: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`T3 does not expose compatible JSON host ${label}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`T3 does not expose compatible JSON host ${label}.`);
  return value as Record<string, unknown>;
}

function assertProtocol(record: Record<string, unknown>, label: string) {
  if (record.protocolVersion !== HOST_PROTOCOL_VERSION)
    throw new Error(`T3 host ${label} protocol ${String(record.protocolVersion)} is incompatible; expected ${HOST_PROTOCOL_VERSION}.`);
  if (record.protectedSecretFile !== true)
    throw new Error(`T3 host ${label} does not guarantee protected secret-file transport.`);
}

function parseCapabilities(stdout: string): Capabilities {
  const record = parseObject(stdout, "capabilities");
  assertProtocol(record, "capabilities");
  return record as Capabilities;
}

async function capabilities(t3: string, env: CommandEnvironment) {
  return parseCapabilities((await run(t3, ["host", "capabilities", "--json"], env)).stdout);
}

function parseStatus(stdout: string): HostStatus {
  const record = parseObject(stdout, "status");
  if (record.mode !== "direct" && record.mode !== "required") throw new Error("T3 host status has an invalid mode.");
  if (record.executable !== undefined && typeof record.executable !== "string")
    throw new Error("T3 host status has an invalid executable.");
  if (record.revision !== undefined && typeof record.revision !== "string")
    throw new Error("T3 host status has an invalid revision.");
  return record as HostStatus;
}

export async function queryStatus(t3: string, baseDir?: string, env: CommandEnvironment = process.env) {
  const compatible = await capabilities(t3, env);
  return { ...compatible, ...parseStatus((await run(t3, ["host", "status", ...(baseDir ? ["--base-dir", baseDir] : [])], env)).stdout) };
}

function associationPath(stateHome: string, baseDir: string) {
  return join(stateHome, "t3-herdr", "associations", `${createHash("sha256").update(resolve(baseDir)).digest("hex")}.json`);
}
function secretPath(stateHome: string, baseDir: string) {
  return associationPath(stateHome, baseDir).replace(/\.json$/, ".secret");
}
export async function saveAssociation(stateHome: string, baseDir: string, secretFile: string) {
  const path = associationPath(stateHome, baseDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ protocolVersion: 1, baseDir: await realpath(baseDir), secretFile })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
export async function loadAssociation(stateHome: string, baseDir: string) {
  return JSON.parse(await readFile(associationPath(stateHome, baseDir), "utf8")) as Association;
}
async function removeArtifacts(stateHome: string, baseDir: string) {
  await Promise.all([
    rm(associationPath(stateHome, baseDir), { force: true }),
    rm(secretPath(stateHome, baseDir), { force: true }),
  ]);
}

export async function installHost(input: { t3: string; baseDir?: string; executable: string; stateHome: string; env?: CommandEnvironment }) {
  const env = input.env ?? process.env;
  await capabilities(input.t3, env);
  const base = input.baseDir ?? dirname(dirname(await realpath(input.t3)));
  const secretFile = secretPath(input.stateHome, base);
  let installAttempted = false;
  try {
    await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
    await writeFile(secretFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
    await chmod(secretFile, 0o600);
    await saveAssociation(input.stateHome, base, secretFile);
    installAttempted = true;
    await run(input.t3, ["host", "install", "--executable", input.executable, "--secret-file", secretFile, ...(input.baseDir ? ["--base-dir", input.baseDir] : [])], env);
    const installed = await queryStatus(input.t3, input.baseDir, env);
    if (installed.mode !== "required" || resolve(installed.executable ?? "") !== resolve(input.executable))
      throw new Error("T3 host install verification failed.");
    return installed;
  } catch (error) {
    if (installAttempted) {
      try {
        await run(input.t3, ["host", "disable", ...(input.baseDir ? ["--base-dir", input.baseDir] : [])], env);
      } catch {}
    }
    await removeArtifacts(input.stateHome, base);
    throw error;
  }
}

export async function disableHost(t3: string, baseDir?: string, options: { stateHome?: string; env?: CommandEnvironment } = {}) {
  const env = options.env ?? process.env;
  await queryStatus(t3, baseDir, env);
  await run(t3, ["host", "disable", ...(baseDir ? ["--base-dir", baseDir] : [])], env);
  const status = await queryStatus(t3, baseDir, env);
  if (status.mode !== "direct") throw new Error("T3 host disable verification failed.");
  if (options.stateHome && baseDir) await removeArtifacts(options.stateHome, baseDir);
  return status;
}
export async function diagnoseHost(t3: string, baseDir?: string, env: CommandEnvironment = process.env) {
  try {
    return { ok: true as const, status: await queryStatus(t3, baseDir, env) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}
