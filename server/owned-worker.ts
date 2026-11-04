import { spawn } from "node:child_process";
import { stopChild } from "./core/process.js";
// The backend supplies this fixed invocation. Model/browser data is only streamed over stdin.
const invocation = JSON.parse(process.argv[2]) as {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};
const child = spawn(invocation.command, invocation.args, {
  cwd: invocation.cwd,
  env: invocation.env,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  stopChild(child);
  // Stay alive long enough to escalate the separately owned tool group even
  // when its immediate parent exits before a stubborn descendant.
  setTimeout(() => process.exit(Number(process.exitCode ?? 0)), 4500);
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdout.on("error", close);
process.stderr.on("error", close);
child.stdin.on("error", close);
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
child.once("error", () => {
  process.stderr.write("The owned local tool could not start.\n");
  process.exitCode = 1;
  close();
});
child.once("exit", (code) => {
  if (!closing) process.exitCode = code ?? 1;
  close();
});
if (child.pid && process.send)
  process.send({ type: "studio:tool-pid", pid: child.pid });
