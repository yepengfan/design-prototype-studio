import { promises as fs } from "node:fs";
import path from "node:path";
import { digest, writeFiles } from "./files.js";
import { installProject } from "./libraries.js";
import type { Snapshot } from "./contracts.js";

/** Reuse an exact installed closure without reinstalling it for every visual edit. */
export class DependencyCache {
  private installations = new Map<string, Promise<string>>();
  constructor(
    private root: string,
    private signal: AbortSignal,
  ) {}
  async materialize(directory: string, snapshot: Snapshot) {
    const pkg = JSON.parse(snapshot.files["package.json"]);
    if (!snapshot.files["package-lock.json"] || pkg.workspaces) {
      await installProject(
        directory,
        snapshot.files,
        snapshot.manifest.libraries,
        false,
        this.signal,
      );
      return;
    }
    const key = digest({
      lock: snapshot.files["package-lock.json"],
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
      registries: snapshot.manifest.libraries.map(({ name, registry }) => ({
        name,
        registry,
      })),
    });
    let installation = this.installations.get(key);
    if (!installation) {
      installation = this.install(key, snapshot);
      this.installations.set(key, installation);
      void installation.catch(() => this.installations.delete(key));
    }
    const modules = await installation;
    await writeFiles(directory, snapshot.files);
    const target = path.join(directory, "node_modules");
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) await fs.unlink(target);
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".bin") continue;
      const file = path.join(target, entry.name),
        source = path.join(modules, entry.name);
      const stat = await fs.lstat(file).catch(() => undefined);
      if (
        stat?.isSymbolicLink() &&
        (await fs.realpath(file)) === (await fs.realpath(source))
      )
        continue;
      if (stat) await fs.rm(file, { recursive: true, force: true });
      await fs.symlink(source, file, entry.isDirectory() ? "dir" : "file");
    }
  }
  private async install(key: string, snapshot: Snapshot) {
    const directory = path.join(this.root, key),
      marker = path.join(directory, ".complete");
    if ((await fs.readFile(marker, "utf8").catch(() => "")) !== key) {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await installProject(
        directory,
        {
          "package.json": snapshot.files["package.json"],
          "package-lock.json": snapshot.files["package-lock.json"],
        },
        snapshot.manifest.libraries,
        false,
        this.signal,
      );
      await fs.writeFile(marker, key, { mode: 0o600 });
    }
    return path.join(directory, "node_modules");
  }
}
