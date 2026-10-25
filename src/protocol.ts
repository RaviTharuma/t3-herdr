import { once } from "node:events";
import type { Writable } from "node:stream";

export type Frame =
  | { type: "hello"; launchId: string; token: string }
  | { type: "start"; launchId: string }
  | { type: "data"; stream: "stdin" | "stdout" | "stderr"; bytes: string }
  | { type: "eof"; stream: "stdin" }
  | { type: "cancel"; launchId: string }
  | { type: "window"; bytes: number }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "cleanup"; launchId: string; token: string };

const keys = (value: object, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => key in value);
const text = (value: unknown) => typeof value === "string" && value.length > 0;
const canonicalBase64 = (value: unknown) => typeof value === "string" && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

export function parseFrame(value: unknown): Frame {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid frame schema");
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "hello": if (keys(frame, ["type", "launchId", "token"]) && text(frame.launchId) && text(frame.token)) return frame as Frame; break;
    case "start": case "cancel": if (keys(frame, ["type", "launchId"]) && text(frame.launchId)) return frame as Frame; break;
    case "window": if (keys(frame, ["type", "bytes"]) && Number.isSafeInteger(frame.bytes) && Number(frame.bytes) > 0) return frame as Frame; break;
    case "data": if (keys(frame, ["type", "stream", "bytes"]) && ["stdin", "stdout", "stderr"].includes(String(frame.stream)) && canonicalBase64(frame.bytes)) return frame as Frame; break;
    case "eof": if (keys(frame, ["type", "stream"]) && frame.stream === "stdin") return frame as Frame; break;
    case "exit": if (keys(frame, ["type", "code", "signal"]) && (frame.code === null || Number.isInteger(frame.code)) && (frame.signal === null || text(frame.signal))) return frame as Frame; break;
    case "cleanup": if (keys(frame, ["type", "launchId", "token"]) && text(frame.launchId) && text(frame.token)) return frame as Frame; break;
  }
  throw new Error("invalid frame schema");
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  constructor(readonly maxBytes = 1024 * 1024) {}
  push(chunk: Uint8Array): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]); const frames: Frame[] = [];
    for (;;) {
      const delimiter = this.#buffer.indexOf(10);
      if (delimiter < 0) { if (this.#buffer.length > this.maxBytes) throw new Error("frame limit exceeded"); return frames; }
      if (delimiter + 1 > this.maxBytes) throw new Error("frame limit exceeded");
      const line = this.#buffer.subarray(0, delimiter); this.#buffer = this.#buffer.subarray(delimiter + 1);
      if (line.length) { let value: unknown; try { value = JSON.parse(line.toString("utf8")); } catch { throw new Error("invalid frame JSON"); } frames.push(parseFrame(value)); }
    }
  }
  end() { if (this.#buffer.length) throw new Error("truncated frame"); }
}

export const encodeFrame = (frame: Frame) => Buffer.from(`${JSON.stringify(parseFrame(frame))}\n`);
const queues = new WeakMap<Writable, Promise<void>>();
export function writeFrame(output: Writable, frame: Frame) {
  const previous = queues.get(output) ?? Promise.resolve();
  const next = previous.then(async () => { if (!output.write(encodeFrame(frame))) await once(output, "drain"); });
  queues.set(output, next.catch(() => {})); return next;
}
export const encodeBytes = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export function decodeBytes(value: string) { if (!canonicalBase64(value)) throw new Error("invalid base64"); return Buffer.from(value, "base64"); }
