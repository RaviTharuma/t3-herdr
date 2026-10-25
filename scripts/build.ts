import { chmod,copyFile,mkdir,rm } from "node:fs/promises";
const target=process.argv[2]??`${process.platform}-${process.arch}`;
await rm("dist",{recursive:true,force:true});await mkdir("dist",{recursive:true});
const run=async(command:string[])=>{const child=Bun.spawn(command,{stdout:"inherit",stderr:"inherit"});if(await child.exited)throw new Error(`${command.join(" ")} failed`)};
await run(["bunx","tsc","-p","tsconfig.json"]);await chmod("dist/cli.js",0o755);await chmod("dist/runner.js",0o755);await run(["bun","build","--compile","src/cli.ts","--outfile","dist/t3-herdr-host"]);
if(target==="darwin-arm64")await run(["clang","-arch","arm64","-Os","native/darwin-process-identity.c","-o","dist/t3-herdr-process-identity"]);else await copyFile("scripts/linux-process-identity","dist/t3-herdr-process-identity");await chmod("dist/t3-herdr-process-identity",0o755);
