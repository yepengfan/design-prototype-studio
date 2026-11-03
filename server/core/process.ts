import { spawn, type ChildProcess } from "node:child_process";
import { StudioError } from "./contracts.js";

export function stopChild(child: ChildProcess, graceMs = 3000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already exited */
    }
  }, graceMs);
  // A tool can exit before descendants that ignore SIGTERM. Keep escalation
  // scheduled for the owned process group until the grace period expires.
  timer.unref();
}
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      if (options.signal?.aborted)
        return reject(new StudioError("The local task was cancelled.", 409));
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        stopChild(child);
      }, options.timeout ?? 120_000);
      const cancel = () => stopChild(child);
      options.signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (data) => {
        if (stdout.length < 2_000_000) stdout += data;
      });
      child.stderr.on("data", (data) => {
        if (stderr.length < 2_000_000) stderr += data;
      });
      child.once("error", (e) => {
        clearTimeout(timeout);
        reject(
          new StudioError(
            `Required local tool could not start: ${command}. ${e.message}`,
          ),
        );
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
        if (options.signal?.aborted)
          reject(new StudioError("The local task was cancelled.", 409));
        else if (timedOut)
          reject(new StudioError(`${command} exceeded its time limit.`, 408));
        else resolve({ stdout, stderr, code: code ?? 1 });
      });
    },
  );
}
export function registryURL(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StudioError("Enter a complete npm registry URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new StudioError(
      "Registry URLs cannot contain credentials or query parameters. Configure npm login outside Studio.",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new StudioError("Use HTTPS for remote registries.");
  return url.href;
}
export function npmFailure(stderr: string) {
  if (/E401|E403|ENEEDAUTH/.test(stderr))
    return "Registry authentication failed. Sign in to this registry with npm, then retry. Studio never stores your token.";
  if (/ERESOLVE|peer dep/.test(stderr))
    return "These package versions have incompatible peer dependencies. Choose compatible published versions.";
  if (/E404|ETARGET/.test(stderr))
    return "The requested package or exact version is unavailable from this registry.";
  if (/ECONN|ENOTFOUND|EAI_AGAIN/.test(stderr))
    return "The registry is unreachable. Check its address and your network connection.";
  return "Package installation failed. Check registry access, supported Node version, and the package release. Registry output is hidden to protect credentials.";
}
