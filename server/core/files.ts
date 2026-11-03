import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Files } from "./contracts.js";
import { StudioError } from "./contracts.js";

export const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function safeRelative(name: string) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    name.split("/").some((p) => p === ".." || p === "." || !p) ||
    /^[a-z]:/i.test(name)
  )
    throw new StudioError("This file path is outside the project.");
  if (
    name
      .split("/")
      .some((p) =>
        [
          "node_modules",
          ".git",
          ".env",
          ".npmrc",
          ".cursor",
          ".codex",
          ".studio",
          "AGENTS.md",
          "CLAUDE.md",
        ].includes(p),
      ) ||
    /(^|\/)\.env(?:\.|$)/.test(name)
  )
    throw new StudioError(
      "Private configuration and generated directories are excluded.",
    );
  return name;
}
const binaryPrefix = "studio-binary:v1:";
const binaryExtensions =
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|mp4|webm)$/i;
export function encodeFile(name: string, data: Buffer) {
  if (binaryExtensions.test(name))
    return binaryPrefix + data.toString("base64");
  const text = data.toString("utf8");
  if (!Buffer.from(text).equals(data) || data.includes(0))
    throw new StudioError(`Unsupported binary file: ${name}`);
  if (text.startsWith(binaryPrefix))
    throw new StudioError("Reserved binary encoding prefix in text source.");
  return text;
}
export function decodeFile(name: string, content: string): Buffer {
  if (!content.startsWith(binaryPrefix)) return Buffer.from(content);
  if (!binaryExtensions.test(name))
    throw new StudioError("Binary encoding is restricted to supported assets.");
  const encoded = content.slice(binaryPrefix.length);
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded)
    throw new StudioError("Invalid binary asset encoding.");
  return data;
}
export function validateFiles(files: Files) {
  const entries = Object.entries(files);
  if (entries.length > 3000)
    throw new StudioError("Project has too many source files.");
  let bytes = 0;
  for (const [name, content] of entries) {
    safeRelative(name);
    bytes += decodeFile(name, content).byteLength;
    if (Buffer.byteLength(content) > 4_000_000)
      throw new StudioError("A source file exceeds the 4 MB limit.");
    if (
      /(_authToken|_password|BEGIN (RSA |OPENSSH )?PRIVATE KEY)|https?:\/\/[^\s/"'<>]+@/i.test(
        content,
      )
    )
      throw new StudioError(
        "Credential material cannot be stored in project source.",
      );
  }
  if (bytes > 40_000_000)
    throw new StudioError("Source exceeds the 40 MB limit.");
}
export async function atomicJSON(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function writeFiles(root: string, files: Files) {
  validateFiles(files);
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, safeRelative(name));
    let directory = root;
    const rootStat = await fs.lstat(root).catch(() => undefined);
    if (rootStat?.isSymbolicLink())
      throw new StudioError("Symbolic links are not supported.");
    for (const segment of name.split("/").slice(0, -1)) {
      directory = path.join(directory, segment);
      const stat = await fs.lstat(directory).catch(() => undefined);
      if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
        throw new StudioError("A project path is not a safe directory.");
      await fs.mkdir(directory, { recursive: true });
    }
    // Only write into newly-created service-owned trees. Never follow an existing link.
    const existing = await fs.lstat(file).catch(() => undefined);
    if (existing?.isSymbolicLink())
      throw new StudioError("Symbolic links are not supported.");
    await fs.writeFile(file, decodeFile(name, value), { mode: 0o600 });
  }
}
export async function readTree(root: string): Promise<Files> {
  const out: Files = {};
  async function walk(dir: string, prefix: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", "dist", "storybook-static"].includes(
          entry.name,
        )
      )
        continue;
      const name = prefix + entry.name;
      safeRelative(name);
      if (entry.isSymbolicLink())
        throw new StudioError("Symbolic links are not supported.");
      if (entry.isDirectory())
        await walk(path.join(dir, entry.name), name + "/");
      else
        out[name] = encodeFile(
          name,
          await fs.readFile(path.join(dir, entry.name)),
        );
    }
  }
  await walk(root, "");
  validateFiles(out);
  return out;
}
