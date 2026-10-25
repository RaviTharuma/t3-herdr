import { describe,expect,test } from "bun:test";
import { readProcessIdentity } from "../src/process-identity.js";
describe("process identity",()=>{test("identifies the current process",async()=>{const x=await readProcessIdentity();expect(x.processId).toBe(process.pid);expect(x.startTime.length).toBeGreaterThan(0);expect(x.bootId.length).toBeGreaterThan(0);expect(x.executable.startsWith("/")).toBe(true)})});
