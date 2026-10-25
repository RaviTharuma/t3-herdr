import { randomBytes } from "node:crypto";
import type { HerdrClient } from "./herdr.js";
import type { ControllerSession } from "./controller.js";
import { Registry, type LaunchRecord } from "./registry.js";

export type ManagedHostedBridge = ControllerSession;
export type Launch = { launchId: string; command: string[]; cwd: string; env?: Record<string, string> };
const HERDR_TARGETS = ["HERDR_SOCKET", "HERDR_WORKSPACE", "HERDR_WORKSPACE_ID", "HERDR_PANE", "HERDR_PANE_ID"];

export class LaunchCoordinator {
  #pending = new Map<string, Promise<ManagedHostedBridge>>();
  constructor(readonly registry: Registry, readonly herdr: HerdrClient, readonly runner: string, readonly socket: string, readonly controller: { expect(association: { launchId: string; token: string }): ControllerSession; revoke(launchId: string, error?: Error): boolean }, readonly workspaceId: string) {}
  launch(launch: Launch) {
    const old = this.registry.get(launch.launchId);
    if (old && old.state !== "failed") return Promise.reject(new Error("launch already exists"));
    const pending = this.#pending.get(launch.launchId);
    if (pending) return pending;
    const attempt = this.#launch(launch, (old?.generation ?? 0) + 1).finally(() => this.#pending.delete(launch.launchId));
    this.#pending.set(launch.launchId, attempt);
    return attempt;
  }
  async #launch(launch: Launch, generation: number) {
    const token = randomBytes(24).toString("hex");
    let record = await this.registry.put({ launchId: launch.launchId, token, generation, state: "launching", started: false });
    const session = this.controller.expect({ launchId: launch.launchId, token });
    const environment: Record<string, string> = { ...(launch.env ?? {}) };
    for (const name of HERDR_TARGETS) delete environment[name];
    Object.assign(environment, { T3_HERDR_LAUNCH_ID: launch.launchId, T3_HERDR_TOKEN: token, T3_HERDR_SOCKET: this.socket });
    let paneId: string | undefined;
    try {
      paneId = this.herdr.applyLayout ? await this.herdr.applyLayout({ workspaceId: this.workspaceId, label: `T3 ${launch.launchId}`, command: [this.runner, "--", ...launch.command], cwd: launch.cwd, env: environment }) : await this.herdr.openPane!([this.runner, "--", ...launch.command], launch.cwd, environment);
      record = { ...record, paneId, state: "ready" };
      await this.registry.put(record);
      session.started.then(() => this.start(launch.launchId, token)).catch(() => {});
      session.closed.then(() => this.cleanup(launch.launchId, token)).catch(() => {});
      return session;
    } catch (error) {
      this.controller.revoke(launch.launchId, error instanceof Error ? error : new Error(String(error)));
      if (paneId) {
        try { await this.herdr.closePane(paneId); } catch {}
      }
      const failed = { ...record, state: "failed" as const, error: error instanceof Error ? error.message : String(error) };
      try { await this.registry.put(failed); } catch {}
      throw error;
    }
  }
  async start(id: string, token: string) {
    const record = this.#fence(id, token);
    if (record.started) return false;
    await this.registry.put({ ...record, started: true, state: "running" });
    return true;
  }
  async cancel(id: string) {
    const record = this.registry.get(id);
    if (!record) return false;
    this.controller.revoke(id, new Error("launch cancelled"));
    if (record.paneId) await this.herdr.closePane(record.paneId);
    await this.registry.put({ ...record, state: "cancelled" });
    return true;
  }
  async cleanup(id: string, token: string) {
    const record = this.registry.get(id);
    if (!record) return false;
    if (record.token !== token) throw new Error("stale launch fence");
    if (record.paneId) await this.herdr.closePane(record.paneId);
    await this.registry.put({ ...record, state: "exited" });
    return true;
  }
  #fence(id: string, token: string) {
    const record = this.registry.get(id);
    if (!record) throw new Error("unknown launch fence");
    if (record.token !== token) throw new Error("stale launch fence");
    return record;
  }
}
