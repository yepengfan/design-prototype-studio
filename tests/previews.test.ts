import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Previews } from "../server/core/preview";
import { blankProject } from "../server/core/project";
import { registryFixture } from "./registry";

it("shutdown cancels a real held npm install and completes before runtime directories are deleted", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "studio-preview-shutdown-"),
  );
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig,
    cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  process.env.npm_config_cache = path.join(root, "cache");
  const previews = new Previews(
    path.join(root, "previews"),
    "http://127.0.0.1:4311",
  );
  try {
    const name = "@studio-test/slow";
    await registry.publish(
      { name, version: "1.0.0", main: "index.js" },
      { "index.js": "module.exports={};" },
    );
    const metadata = await (
      await fetch(registry.base + "/" + encodeURIComponent(name), {
        headers: { Authorization: "Bearer synthetic-local-fixture" },
      })
    ).json();
    const dist = metadata.versions["1.0.0"].dist;
    const project = blankProject("Shutdown");
    project.files["package.json"] = JSON.stringify({
      name: "shutdown",
      version: "1.0.0",
      private: true,
      dependencies: { [name]: "1.0.0" },
    });
    project.files["package-lock.json"] = JSON.stringify({
      name: "shutdown",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "shutdown",
          version: "1.0.0",
          dependencies: { [name]: "1.0.0" },
        },
        ["node_modules/" + name]: {
          version: "1.0.0",
          resolved: dist.tarball,
          integrity: dist.integrity,
        },
      },
    });
    // npm pack can seed its own content cache. Hold a genuinely uncached fetch.
    process.env.npm_config_cache = path.join(root, "install-cache");
    registry.hold();
    const materialization = previews.materialize({
      ...project,
      id: "0".repeat(64),
      label: "test",
      at: new Date().toISOString(),
    });
    await expect
      .poll(() => registry.pendingRequests(), { timeout: 15000, interval: 20 })
      .toBeGreaterThan(0);
    const [task, closed] = await Promise.allSettled([
      materialization,
      previews.close(),
    ]);
    expect(task.status).toBe("rejected");
    expect(closed.status).toBe("fulfilled");
    await expect
      .poll(() => registry.pendingRequests(), { timeout: 5000 })
      .toBe(0);
    await fs.rm(path.join(root, "previews"), { recursive: true, force: true });
    expect(
      await fs.stat(path.join(root, "previews")).catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await previews.close();
    await registry.close();
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
