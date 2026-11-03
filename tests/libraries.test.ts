import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryFixture } from "./registry";
import {
  installProject,
  inspectLibrary,
  searchComponents,
} from "../server/core/libraries";
import { npmFailure } from "../server/core/process";
it("authenticates to a real local registry, admits two packages, preserves identities and pins releases without exporting credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-registry-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig;
  const cache = process.env.npm_config_cache;
  process.env.npm_config_cache = path.join(root, "npm-cache");
  try {
    const files = {
      "package.json": JSON.stringify({
        private: true,
        dependencies: {
          react: "19.3.1",
          "@studio-test/controls": "1.0.0",
          "@studio-test/layout": "1.0.0",
        },
      }),
    };
    process.env.npm_config_userconfig = path.join(root, "missing-config");
    await expect(
      installProject(path.join(root, "unauthorized"), files, [
        { name: "@studio-test/controls", registry: registry.base },
      ]),
    ).rejects.toThrow("authentication");
    process.env.npm_config_userconfig = registry.config;
    const installed = path.join(root, "installed");
    const lock = await installProject(installed, files, [
      { name: "@studio-test/controls", registry: registry.base },
      { name: "@studio-test/layout", registry: registry.base },
    ]);
    const controls = await inspectLibrary(
      installed,
      "@studio-test/controls",
      "1.0.0",
    );
    const layouts = await inspectLibrary(
      installed,
      "@studio-test/layout",
      "1.0.0",
    );
    const found = searchComponents(
      [...controls.components, ...layouts.components],
      "related content",
    );
    expect(found[0].name).toBe("Card");
    expect(found[0].package).toBe("@studio-test/layout");
    expect(controls.components[0].examples).toHaveLength(2);
    expect(
      JSON.parse(lock).packages["node_modules/@studio-test/controls"].version,
    ).toBe("1.0.0");
    expect(registry.requests()).toBeGreaterThan(2);
    expect(lock).not.toContain("synthetic-local-fixture");
    expect(npmFailure("E401 https://registry/?token=private")).not.toContain(
      "private",
    );
    expect(npmFailure("ERESOLVE")).toContain("peer");
  } finally {
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
