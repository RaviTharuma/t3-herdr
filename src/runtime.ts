import { chmod,mkdir,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function runtimeHome(environment:NodeJS.ProcessEnv=process.env){const configured=environment.XDG_RUNTIME_DIR;const root=await realpath(configured??tmpdir());const path=join(root,configured?"t3-herdr":`t3-herdr-${process.getuid?.()??"user"}`);await mkdir(path,{recursive:true,mode:0o700});await chmod(path,0o700);return path}
