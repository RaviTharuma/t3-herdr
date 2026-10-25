import { describe, expect, test } from "bun:test";
import { join } from "node:path";
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const run = (...args: string[]) => Bun.spawnSync(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
describe("packed CLI metadata", () => {
  test.each(["--help", "-h"])("%s prints usage and exits successfully", (flag) => {
    const result = run(flag);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: t3-herdr");
    expect(result.stderr.toString()).toBe("");
  });
  test("--version prints the package version and exits successfully", () => {
    const result = run("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("0.2.0\n");
    expect(result.stderr.toString()).toBe("");
  });
});
