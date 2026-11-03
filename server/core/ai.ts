import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { runCommand } from "./process.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  proposalSchema,
  StudioError,
  type Snapshot,
  type Proposal,
  type Run,
} from "./contracts.js";
import { stopChild } from "./process.js";
import { atomicJSON, writeFiles, digest } from "./files.js";
import { parseRequirements } from "./requirements.js";

// The model proposes source as JSON. Only the service materializes files after validation.
// A macOS process sandbox independently denies writes outside this run's staging tree.
export function sandboxProfile(
  root: string,
  runtime = root,
  toolState: { path: string; directory?: boolean }[] = [],
) {
  const literal = JSON.stringify(root);
  return `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${literal}) (subpath ${JSON.stringify(runtime)}) (literal "/dev/null") (literal "/dev/tty")) ${toolState.map((p) => `(allow file-write* (${p.directory ? "subpath" : "literal"} ${JSON.stringify(p.path)}))`).join(" ")}`;
}
type Packet = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { message: string; data?: { message?: string } };
}; // Protocol is validated at each method boundary.
const protocolMethods = new Set([
  "initialize",
  "initialized",
  "config/read",
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "turn/completed",
  "item/agentMessage/delta",
  "error",
  "session/new",
  "session/set_mode",
  "session/prompt",
  "session/cancel",
  "session/update",
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
  "terminal/kill",
]);
const updateKinds = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "user_message_chunk",
]);
export class RPC {
  readonly protocol = {
    invocation: randomUUID(),
    started: Date.now(),
    completed: undefined as number | undefined,
    outcome: undefined as string | undefined,
    lastEvent: undefined as
      | {
          ms: number;
          direction: string;
          kind: string;
          method: string;
          update?: string;
        }
      | undefined,
    events: [] as {
      ms: number;
      direction: string;
      kind: string;
      method: string;
      update?: string;
    }[],
    counts: {} as Record<string, number>,
    pendingAtFailure: [] as string[],
  };
  private trace(
    direction: string,
    kind: string,
    method: string,
    update?: unknown,
  ) {
    const name = protocolMethods.has(method) ? method : "unrecognized";
    const subtype =
      typeof update === "string" && updateKinds.has(update)
        ? update
        : undefined;
    const key = [direction, kind, name, subtype ?? ""].join(":");
    this.protocol.counts[key] = (this.protocol.counts[key] ?? 0) + 1;
    const event = {
      ms: Date.now() - this.protocol.started,
      direction,
      kind,
      method: name,
      update: subtype,
    };
    this.protocol.lastEvent = event;
    if (this.protocol.events.length < 1000) this.protocol.events.push(event);
  }
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; method: string }
  >();
  readonly child: ChildProcessWithoutNullStreams;
  onEvent: (p: Packet) => void = () => {};
  toolPid?: number;
  onToolPid?: (pid: number) => void;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    sandbox = true,
    runtimeEnv: NodeJS.ProcessEnv = {},
    allowedRoot = cwd,
    runtime = allowedRoot,
    toolState: { path: string; directory?: boolean }[] = [],
    diagnostic?: (pid: number, paths?: string[]) => void,
  ) {
    if (sandbox && process.platform !== "darwin")
      throw new StudioError(
        "Local AI integration currently requires macOS process isolation.",
      );
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: cwd,
      CODEX_SQLITE_HOME: cwd,
      NO_COLOR: "1",
      ...runtimeEnv,
    };
    const invocation = {
      command: sandbox ? "/usr/bin/sandbox-exec" : command,
      args: sandbox
        ? [
            "-p",
            sandboxProfile(allowedRoot, runtime, toolState),
            command,
            ...args,
          ]
        : args,
      cwd,
      env,
    };
    this.child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../owned-worker.ts", import.meta.url)),
        JSON.stringify(invocation),
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        detached: true,
        env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    ) as ChildProcessWithoutNullStreams;
    this.child.on("message", (message) => {
      const event = message as { type?: string; pid?: number };
      if (event.type === "studio:tool-pid" && typeof event.pid === "number") {
        this.toolPid = event.pid;
        this.onToolPid?.(event.pid);
      }
    });
    let bytes = 0;
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      bytes += line.length;
      if (bytes > 20_000_000) {
        this.close();
        return;
      }
      let p: Packet;
      try {
        p = JSON.parse(line);
      } catch {
        return;
      }
      if (p.id !== undefined && !p.method) {
        const entry = this.pending.get(Number(p.id));
        if (!entry) return;
        this.pending.delete(Number(p.id));
        this.trace("in", p.error ? "error-response" : "response", entry.method);
        if (p.error)
          entry.reject(
            new StudioError(
              `${entry.method}: ${p.error.message}${p.error.data?.message === "Failed to initialize session services" ? " (session service initialization)" : ""}`,
            ),
          );
        else entry.resolve(p.result);
      } else if (p.id !== undefined && p.method) {
        this.trace("in", "client-request", p.method);
        this.trace("out", "denied-client-request", p.method);
        // No browser or model-controlled filesystem, shell, MCP or permission proxy.
        if (p.method === "session/request_permission")
          this.send({
            jsonrpc: "2.0",
            id: p.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        else
          this.send({
            jsonrpc: "2.0",
            id: p.id,
            error: {
              code: -32601,
              message:
                "Studio accepts structured proposals only. Client tools are disabled.",
            },
          });
      } else {
        this.trace(
          "in",
          "notification",
          p.method ?? "",
          p.params?.update?.sessionUpdate,
        );
        this.onEvent(p);
      }
    });
    const diagnostics = new Set<string>();
    this.child.stderr.on("data", (chunk) => {
      // Classify known startup failures without retaining raw text, paths, URLs or account data.
      const text = String(chunk);
      if (this.child.pid)
        diagnostic?.(
          this.child.pid,
          text.match(
            /(?:\/Users|\/private|\/var|\/tmp|\/dev)\/[A-Za-z0-9_./-]+/g,
          ) ?? [],
        );
      for (const [pattern, label] of [
        [
          /Operation not permitted|Permission denied|EPERM|EACCES/i,
          "filesystem permission denied",
        ],
        [
          /unknown option|unexpected argument|unrecognized/i,
          "unsupported CLI option",
        ],
        [/auth|login|sign.in/i, "authentication unavailable"],
        [/config/i, "configuration loading"],
        [/sandbox/i, "process sandbox"],
        [/sqlite|database/i, "local session storage"],
      ] as const)
        if (pattern.test(text)) diagnostics.add(label);
    });
    this.child.once("error", () =>
      this.fail(
        new StudioError(
          "The selected local AI tool could not start. Install and sign in with its CLI.",
        ),
      ),
    );
    this.child.once("exit", (code, signal) =>
      this.fail(
        new StudioError(
          `The AI tool stopped (${code ?? signal}). ${[...diagnostics].join("; ") || "No safe startup diagnostic was reported"}. Accepted work is unchanged.`,
        ),
      ),
    );
  }
  private fail(e: Error) {
    if (this.pending.size)
      this.protocol.pendingAtFailure = [...this.pending.values()].map(
        (entry) =>
          protocolMethods.has(entry.method) ? entry.method : "unrecognized",
      );
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
  send(p: unknown) {
    if (!this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(p) + "\n");
  }
  notify(method: string, params: unknown = {}) {
    this.trace("out", "notification", method);
    this.send({ jsonrpc: "2.0", method, params });
  }
  call(method: string, params: unknown = {}): Promise<any> {
    this.trace("out", "request", method);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  close() {
    this.fail(new StudioError("AI connection closed."));
    stopChild(this.child, 6000);
  }
}
export function generationPrompt(snapshot: Snapshot, request: string) {
  const scope = parseRequirements(snapshot.files, snapshot.manifest.scope);
  const selectedRequirements = new Set(scope.files.map((file) => file.file));
  const source = Object.fromEntries(
    Object.entries(snapshot.files).filter(
      ([name, content]) =>
        name !== "package-lock.json" &&
        (!name.endsWith(".feature") || selectedRequirements.has(name)) &&
        !content.startsWith("studio-binary:v1:"),
    ),
  );
  const inventory = Object.entries(snapshot.files)
    .filter(([name]) => !(name in source))
    .map(([name, content]) => ({
      name,
      hash: digest(content),
      bytes: Buffer.byteLength(content),
    }));
  return `You are editing a reusable React frontend project for a designer. Return exactly one JSON object matching this schema, with only complete changed/new files in files, explicit removed paths in deleted, and no markdown fences. Omitted files remain unchanged. Use manifestChanges for page/scenario/style/provider changes; do not repeat or alter library metadata or dependency manifests: ${JSON.stringify(z.toJSONSchema(proposalSchema))}\nDo not use tools, commands, file reads, MCP, hooks, delegation or extensions. All context is supplied below. Never invent replacement interactive controls: use genuine admitted library exports. If capabilities, published information or business facts are missing, return kind gap or clarification and questions, with files empty and no deletions. Preserve untouched source, controllers, styling, dependencies and independent scenarios. Never connect independent features without a requirement. Implement all selected Gherkin scenarios with complete initial fixtures, typed replaceable query/operation adapters, validation, interactions, Storybook stories and explicit step bindings. Change business behavior only with a proposed matching .feature difference; presentation-only changes leave Gherkin intact. Unknown business facts require questions before implementing affected behavior. No machine paths, credentials, lifecycle scripts or configuration for agents.\nSelected requirements: ${JSON.stringify(scope)}\nAdmitted libraries and manifest: ${JSON.stringify(snapshot.manifest)}\nCurrent editable source: ${JSON.stringify(source)}\nUnchanged binary/locked artifact inventory: ${JSON.stringify(inventory)}\nDesigner request: ${request}`;
}
export class LocalAI {
  private active = new Map<string, { rpc: RPC; cancel: () => Promise<void> }>();
  constructor(
    readonly root: string,
    private diagnostic?: (pid: number, paths?: string[]) => void,
  ) {}
  // Allows protocol fixtures to hold a historical input contract constant.
  // No browser or project file can replace this formatter.
  protected formatPrompt(snapshot: Snapshot, request: string) {
    return generationPrompt(snapshot, request);
  }
  async generate(
    run: Run,
    snapshot: Snapshot,
    update: (event: string, session?: string, turn?: string) => Promise<void>,
  ): Promise<Proposal> {
    const runRoot = path.join(this.root, run.id);
    const root = path.join(runRoot, "project");
    // Cursor's Unix socket state needs a short base path (installed CLI limit: 83 chars).
    const runtime = await fs.realpath(await fs.mkdtemp("/tmp/studio-ai-"));
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    await writeFiles(root, snapshot.files);
    // Give CLI discovery an explicit isolated repository root, never the Studio host repository.
    const initialized = await runCommand("git", ["init", "--quiet"], root);
    if (initialized.code)
      throw new StudioError(
        "Studio could not initialize the isolated proposal workspace.",
      );
    await fs.writeFile(path.join(root, ".studio-ai-root"), "");
    const codexHome =
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const isCodex = run.adapter === "codex";
    const disabled = [
      "hooks",
      "plugins",
      "apps",
      "shell_tool",
      "unified_exec",
      "code_mode",
      "code_mode_host",
      "browser_use",
      "computer_use",
      "multi_agent",
      "skill_search",
      "memories",
      "view_image",
      "skill_mcp_dependency_install",
    ];
    const args = isCodex
      ? [
          "app-server",
          "--listen",
          "stdio://",
          ...disabled.flatMap((f) => ["--disable", f]),
          "-c",
          'project_root_markers=[".studio-ai-root"]',
          "-c",
          `log_dir=${JSON.stringify(path.join(runtime, "logs"))}`,
          "-c",
          'history.persistence="none"',
          "--enable",
          "skip_host_skill_discovery",
        ]
      : ["--mode", "ask", "--sandbox", "enabled", "--workspace", root, "acp"];
    const toolState: { path: string; directory?: boolean }[] = isCodex
      ? [
          { path: path.join(codexHome, "installation_id") },
          { path: path.join(codexHome, "tmp"), directory: true },
        ]
      : [];
    if (!isCodex) {
      const version = await runCommand(
        "agent",
        ["--disable-auto-update", "--version"],
        root,
      );
      const release = version.stdout.trim();
      if (/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9]+$/.test(release)) {
        const running = path.join(
          os.homedir(),
          ".local",
          "share",
          "cursor-agent",
          "versions",
          release,
          ".running",
        );
        toolState.push({ path: running, directory: true });
      }
    }
    const rpc = new RPC(
      isCodex ? "codex" : "agent",
      args,
      root,
      true,
      {
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: runtime,
        CURSOR_DATA_DIR: path.join(runtime, "cursor"),
        CURSOR_CONFIG_DIR: path.join(runtime, "cursor-config"),
        NODE_COMPILE_CACHE: path.join(runtime, "node-cache"),
        XDG_CACHE_HOME: path.join(runtime, "cache"),
      },
      runRoot,
      runtime,
      toolState,
      this.diagnostic,
    );
    rpc.onToolPid = (pid) => {
      void atomicJSON(path.join(runRoot, "runtime.json"), {
        runtime,
        pid: rpc.child.pid,
        toolPid: pid,
      });
    };
    await atomicJSON(path.join(runRoot, "runtime.json"), {
      runtime,
      pid: rpc.child.pid,
      toolPid: rpc.toolPid,
    });
    if (rpc.child.pid) this.diagnostic?.(rpc.child.pid);
    let session = "",
      turn = "",
      output = "",
      cancelled = false;
    let failureCode = "";
    let complete!: () => void;
    let fail!: (e: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // Attach a handler before any initialization can fail.
    void done.catch(() => {});
    rpc.child.once("exit", () =>
      fail(
        new StudioError("The AI process exited before completing a proposal."),
      ),
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fail(
        new StudioError("The AI request timed out. Retry from accepted work."),
      );
      rpc.close();
    }, 600_000);
    let pendingText = "";
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let progressWrites = Promise.resolve();
    const flushProgress = () => {
      clearTimeout(progressTimer);
      progressTimer = undefined;
      if (pendingText) {
        const text = pendingText;
        pendingText = "";
        progressWrites = progressWrites.then(() => update(text));
        void progressWrites.catch((error) => {
          fail(error);
          rpc.close();
        });
      }
      return progressWrites;
    };
    const progress = (text: string) => {
      pendingText += text;
      // Streaming can produce thousands of tiny deltas. Persist batches while
      // retaining task state independently of a browser connection.
      progressTimer ??= setTimeout(() => void flushProgress(), 100);
    };
    const activity = new Set<string>();
    rpc.onEvent = (p) => {
      if (p.method === "error")
        failureCode = JSON.stringify(p.params?.error ?? "")
          .replace(
            /https?:\/\/\S+|(?:\/Users|\/private|\/tmp)\/\S+/g,
            "[private location]",
          )
          .slice(0, 500);
      if (isCodex && p.method === "item/agentMessage/delta") {
        output += p.params?.delta ?? "";
        progress(String(p.params?.delta ?? ""));
      }
      if (!isCodex && p.method === "session/update") {
        const u = p.params?.update;
        if (
          ["agent_thought_chunk", "tool_call", "plan"].includes(
            u?.sessionUpdate,
          ) &&
          !activity.has(u.sessionUpdate)
        ) {
          activity.add(u.sessionUpdate);
          progress(
            u.sessionUpdate === "tool_call"
              ? "The tool is requesting workspace inspection; Studio permits structured proposals only."
              : "The tool is planning the proposal.",
          );
        }
        if (
          u?.sessionUpdate === "agent_message_chunk" &&
          u.content?.type === "text"
        ) {
          output += u.content.text;
          progress(u.content.text);
        }
      }
      if (p.method === "turn/completed") {
        if (p.params?.turn?.status === "completed") complete();
        else {
          const error = p.params?.turn?.error;
          const detail = JSON.stringify(error ?? failureCode)
            .replace(
              /https?:\/\/\S+|(?:\/Users|\/private|\/tmp)\/\S+/g,
              "[private location]",
            )
            .slice(0, 500);
          fail(
            new StudioError(`The AI turn was interrupted or failed. ${detail}`),
          );
        }
      }
    };
    this.active.set(run.id, {
      rpc,
      cancel: async () => {
        cancelled = true;
        setTimeout(() => rpc.close(), 1500).unref();
        fail(new StudioError("Cancelled. Partial output is quarantined."));
        if (session) {
          if (isCodex && turn)
            void rpc
              .call("turn/interrupt", { threadId: session, turnId: turn })
              .catch(() => {});
          else rpc.notify("session/cancel", { sessionId: session });
        }
      },
    });
    try {
      if (isCodex) {
        await rpc.call("initialize", {
          clientInfo: { name: "design_prototype_studio", version: "0.1.0" },
        });
        rpc.notify("initialized");
        // Discover names only, then disable inherited servers before creating any thread.
        const config = await rpc.call("config/read", { includeLayers: false });
        const mcp = Object.fromEntries(
          Object.keys(config.config?.mcp_servers ?? {}).map((name) => [
            name,
            { enabled: false },
          ]),
        );
        const started = await rpc.call("thread/start", {
          cwd: root,
          model: "gpt-6.1-sol",
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          config: { mcp_servers: mcp, web_search: "disabled" },
        });
        session = started.thread.id;
        await update("Preparing proposal", session);
        const result = await rpc.call("turn/start", {
          threadId: session,
          effort: "medium",
          input: [
            { type: "text", text: this.formatPrompt(snapshot, run.prompt) },
          ],
        });
        turn = result.turn.id;
        await update("Generating", session, turn);
        await done;
      } else {
        await rpc.call("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "design-prototype-studio", version: "0.1.0" },
        });
        const started = await rpc.call("session/new", {
          cwd: root,
          mcpServers: [],
        });
        session = started.sessionId;
        if (
          started.modes?.availableModes?.some(
            (m: { id: string }) => m.id === "ask",
          )
        )
          await rpc.call("session/set_mode", {
            sessionId: session,
            modeId: "ask",
          });
        await update("Generating", session);
        const result = await rpc.call("session/prompt", {
          sessionId: session,
          prompt: [
            { type: "text", text: this.formatPrompt(snapshot, run.prompt) },
          ],
        });
        if (result.stopReason !== "end_turn")
          throw new StudioError("Cursor did not complete the proposal.");
      }
      await flushProgress();
      if (cancelled) throw new StudioError("Cancelled.");
      const json = output
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
      const proposal = proposalSchema.parse(JSON.parse(json));
      rpc.protocol.outcome = "success";
      return proposal;
    } catch (error) {
      rpc.protocol.outcome = timedOut
        ? "timed-out"
        : cancelled
          ? "cancelled"
          : "failed";
      if (timedOut)
        throw new StudioError(
          "The AI request exceeded ten minutes. Accepted work is unchanged; retry or choose another installed tool.",
          408,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(progressTimer);
      await flushProgress().catch(() => {});
      this.active.delete(run.id);
      rpc.protocol.completed = Date.now();
      await atomicJSON(
        path.join(runRoot, `protocol-${rpc.protocol.invocation}.json`),
        rpc.protocol,
      ).catch(() => {});
      await atomicJSON(path.join(runRoot, "protocol.json"), rpc.protocol).catch(
        () => {},
      );
      rpc.close();
    }
  }
  async cancel(id: string) {
    const active = this.active.get(id);
    if (active) await active.cancel();
  }
  close() {
    for (const a of this.active.values()) a.rpc.close();
    this.active.clear();
  }
}
