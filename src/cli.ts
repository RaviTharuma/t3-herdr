#!/usr/bin/env bun
import { join, dirname } from "node:path";import { homedir } from "node:os";import { fileURLToPath } from "node:url";import { readFile } from "node:fs/promises";import { createT3Host } from "./server.js";import { diagnoseHost,disableHost,installHost,queryStatus } from "./install.js";import { foreground } from "./host.js";
const HELP = `Usage: t3-herdr <command> [options]

Commands:
  install      Associate this host with a T3 checkout
  status       Show the T3 host policy
  disable      Restore direct T3 execution
  diagnose     Verify T3 host compatibility
  diagnostics  Show local host registry diagnostics
  foreground   Run the foreground host
  run          Run one managed launch

Options:
  -h, --help   Show help
  --version    Show version
`;
const VERSION = "0.1.0";
const argv=process.argv.slice(2),command=argv.shift();
if(command==="--help"||command==="-h"){console.log(HELP);process.exit(0)}
if(command==="--version"){console.log(VERSION);process.exit(0)}const state=process.env.XDG_STATE_HOME??join(homedir(),".local/state");const option=(name:string)=>{const i=argv.indexOf(name);if(i<0)return undefined;const value=argv[i+1];if(!value||value.startsWith("--"))throw new Error(`${name} requires a value`);argv.splice(i,2);return value};
if(command==="foreground"){process.exitCode=await foreground(argv,state)}
else if(["install","status","disable","diagnose"].includes(command??"")){const t3=option("--t3");if(!t3)throw new Error(`usage: t3-herdr ${command} --t3 <path> [--base-dir <path>]`);const baseDir=option("--base-dir");if(argv.length)throw new Error(`unknown arguments: ${argv.join(" ")}`);const executable=process.argv[0]!.endsWith("t3-herdr-host")?process.argv[0]!:fileURLToPath(new URL("./t3-herdr-host",import.meta.url));const result=command==="install"?await installHost({t3,baseDir,executable,stateHome:state}):command==="status"?await queryStatus(t3,baseDir):command==="disable"?await disableHost(t3,baseDir,{stateHome:state}):await diagnoseHost(t3,baseDir);console.log(JSON.stringify(result,null,2));if(command==="diagnose"&&"ok" in result&&!result.ok)process.exitCode=1}
else if(command==="diagnostics"){const path=join(state,"t3-herdr/registry.json");let records:unknown=[];try{records=JSON.parse(await readFile(path,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}console.log(JSON.stringify({protocolVersion:1,registry:path,records},null,2))}
else if(command==="run"&&argv.length===3){const runtime=process.env.XDG_RUNTIME_DIR;if(!runtime)throw new Error("XDG_RUNTIME_DIR is required");const host=createT3Host({repository:argv[0]!,workspaceId:argv[1]!,stateHome:state,runtimeDir:runtime,herdrSocket:process.env.HERDR_SOCKET_PATH??join(runtime,"herdr.sock"),runner:new URL("./runner.js",import.meta.url).pathname});await host.registry.load();await host.controller.listen();const session=await host.launch(argv[2]!);await session.started;console.error(JSON.stringify({type:"ready",launchId:argv[2]}));console.log(JSON.stringify(await session.completed));await host.controller.close()}
else throw new Error("usage: t3-herdr install|status|disable|diagnose --t3 <path> [--base-dir <path>] | run <repository> <workspace-id> <launch-id> | diagnostics");
