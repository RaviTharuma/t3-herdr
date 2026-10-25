import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
export type ProcessIdentity={processId:number;startTime:string;bootId:string;executable:string};
const execute=promisify(execFile);
export async function readProcessIdentity(processId=process.pid):Promise<ProcessIdentity>{if(process.platform==="linux"){const text=await readFile(`/proc/${processId}/stat`,"utf8");const startTime=text.slice(text.lastIndexOf(")")+2).split(" ")[19];if(!startTime)throw new Error("missing host process start time");return{processId,startTime,bootId:(await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim(),executable:await realpath(`/proc/${processId}/exe`)}}if(process.platform==="darwin"){const helper=fileURLToPath(new URL(import.meta.url.endsWith(".ts")?"../dist/t3-herdr-process-identity":"./t3-herdr-process-identity",import.meta.url));const{stdout}=await execute(helper,[String(processId)],{encoding:"utf8"});const identity=JSON.parse(stdout) as ProcessIdentity;identity.executable=await realpath(identity.executable);return identity}throw new Error(`unsupported platform: ${process.platform}`)}
