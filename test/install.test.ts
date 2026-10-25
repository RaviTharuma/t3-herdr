import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseHost, disableHost, installHost, queryStatus } from "../src/install";

type FakeCapabilities = { protocolVersion: number; protectedSecretFile: boolean };
type FakeFixture = Awaited<ReturnType<typeof createFake>>;

async function createFake(capabilities: FakeCapabilities = { protocolVersion: 1, protectedSecretFile: true }) {
  const dir = await mkdtemp(join(tmpdir(), "t3-herdr-install-test-"));
  const home = join(dir, "home");
  const configHome = join(dir, "config");
  const dataHome = join(dir, "data");
  const stateHome = join(dir, "state");
  const cacheHome = join(dir, "cache");
  const runtimeDir = join(dir, "runtime");
  const cli = join(dir, "t3");
  const policy = join(dir, "policy.json");
  const args = join(dir, "args.json");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_RUNTIME_DIR: runtimeDir,
  };
  await writeFile(cli, `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(${JSON.stringify(args)}, JSON.stringify(a));
if (a[0] !== "host") process.exit(2);
if (a[1] === "capabilities") {
  console.log(JSON.stringify(${JSON.stringify(capabilities)}));
  process.exit(0);
}
let p = existsSync(${JSON.stringify(policy)})
  ? JSON.parse(readFileSync(${JSON.stringify(policy)}, "utf8"))
  : { mode: "direct" };
if (a[1] === "status") console.log(JSON.stringify(p));
else if (a[1] === "install") {
  const f = a[a.indexOf("--secret-file") + 1];
  if (!f || !existsSync(f)) process.exit(3);
  p = { mode: "required", secretFile: f,
    executable: a[a.indexOf("--executable") + 1].endsWith("fail-host") ? "/wrong" : a[a.indexOf("--executable") + 1], revision: "r", secret: readFileSync(f, "utf8") };
  writeFileSync(${JSON.stringify(policy)}, JSON.stringify(p));
} else if (a[1] === "disable") {
  p = { mode: "direct", revision: "d" };
  writeFileSync(${JSON.stringify(policy)}, JSON.stringify(p));
}
`);
  await chmod(cli, 0o755);
  return { dir, cli, policy, args, env, stateHome };
}

async function withFake<T>(run: (fixture: FakeFixture) => Promise<T>, capabilities?: FakeCapabilities) {
  const fixture = await createFake(capabilities);
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

async function stateFiles(state: string) {
  try {
    return (await readdir(state, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(state.length + 1));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("T3 host installation", () => {
  test("uses protected file, verifies exact JSON status, and disables safely", () => withFake(async (f) => {
    const executable = join(f.dir, "host");
    expect((await installHost({ t3: f.cli, baseDir: f.dir, executable, stateHome: f.stateHome, env: f.env })).mode).toBe("required");
    const policy = JSON.parse(await readFile(f.policy, "utf8"));
    expect(policy.secret.length).toBeGreaterThanOrEqual(43);
    expect(await readFile(f.args, "utf8")).not.toContain(policy.secret);
    expect(await queryStatus(f.cli, f.dir, f.env)).toMatchObject({ protocolVersion: 1, protectedSecretFile: true, mode: "required" });
    expect((await diagnoseHost(f.cli, f.dir, f.env)).ok).toBe(true);
    expect((await disableHost(f.cli, f.dir, { stateHome: f.stateHome, env: f.env })).mode).toBe("direct");
    expect(await stateFiles(f.stateHome)).toEqual([]);
  }));

  test("rejects incompatible CLI before persisting a secret", () => withFake(async (f) => {
    await expect(installHost({ t3: f.cli, baseDir: f.dir, executable: "/host", stateHome: f.stateHome, env: f.env })).rejects.toThrow("secret-file");
    expect(await Bun.file(f.policy).exists()).toBe(false);
    expect(await Bun.file(f.stateHome).exists()).toBe(false);
  }, { protocolVersion: 1, protectedSecretFile: false }));

  test("deterministically rolls back T3 and artifacts after verification failure", () => withFake(async (f) => {
    await expect(installHost({ t3: f.cli, baseDir: f.dir, executable: join(f.dir, "fail-host"), stateHome: f.stateHome, env: f.env })).rejects.toThrow("verification");
    expect(JSON.parse(await readFile(f.policy, "utf8")).mode).toBe("direct");
    expect(await stateFiles(f.stateHome)).toEqual([]);
  }));

  test("persists only an association reference and package-owned secret", () => withFake(async (f) => {
    await installHost({ t3: f.cli, baseDir: f.dir, executable: join(f.dir, "host"), stateHome: f.stateHome, env: f.env });
    const files = await stateFiles(f.stateHome);
    const association = files.find((x) => x.endsWith(".json"))!;
    const secret = files.find((x) => x.endsWith(".secret"))!;
    expect(JSON.parse(await readFile(join(f.stateHome, association), "utf8"))).toEqual({ protocolVersion: 1, baseDir: f.dir, secretFile: join(f.stateHome, secret) });
    expect(JSON.parse(await readFile(f.policy, "utf8")).secretFile).toBe(join(f.stateHome, secret));
  }));

  test("fixtures are parallel-safe", async () => {
    const fixtures = await Promise.all(Array.from({ length: 8 }, () => createFake()));
    try {
      const results = await Promise.all(fixtures.map(async (f) => {
        await installHost({ t3: f.cli, baseDir: f.dir, executable: join(f.dir, "host"), stateHome: f.stateHome, env: f.env });
        return JSON.parse(await readFile(f.policy, "utf8")).secretFile;
      }));
      expect(new Set(results).size).toBe(fixtures.length);
      for (let index = 0; index < fixtures.length; index++)
        expect(results[index]).toStartWith(fixtures[index]!.stateHome);
    } finally {
      await Promise.all(fixtures.map((f) => rm(f.dir, { recursive: true, force: true })));
    }
  });

  test("status accepts the exact core response fields", () => withFake(async (f) => {
    await writeFile(f.policy, JSON.stringify({ mode: "direct" }));
    expect(await queryStatus(f.cli, f.dir, f.env)).toEqual({ protocolVersion: 1, protectedSecretFile: true, mode: "direct" });
    expect((await diagnoseHost(f.cli, f.dir, f.env)).ok).toBe(true);
    expect((await disableHost(f.cli, f.dir, { env: f.env })).mode).toBe("direct");
  }));
});
