import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LaunchState = "launching" | "ready" | "running" | "cancelled" | "exited" | "failed";
export type LaunchRecord = { launchId: string; token: string; generation: number; state: LaunchState; paneId?: string; started: boolean; error?: string };

export class Registry {
  #records = new Map<string, LaunchRecord>();
  constructor(readonly path: string) {}
  async load() {
    try {
      for (const record of JSON.parse(await readFile(this.path, "utf8")) as LaunchRecord[]) {
        this.#records.set(record.launchId, { ...record, generation: record.generation ?? 1 });
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  get(id: string) { return this.#records.get(id); }
  values() { return [...this.#records.values()]; }
  async put(record: LaunchRecord) {
    const next = new Map(this.#records);
    next.set(record.launchId, record);
    await this.#save([...next.values()]);
    this.#records = next;
    return record;
  }
  async #save(records: LaunchRecord[]) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + `.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
