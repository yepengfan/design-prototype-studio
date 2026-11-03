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

it("uses published documentation without custom metadata, diagnoses concrete gaps and restores exact releases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-release-test-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig,
    cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  process.env.npm_config_cache = path.join(root, "cache");
  const name = "@studio-test/documented";
  const files = {
    "index.js":
      "import {createElement as h} from 'react';export function Callout({children,tone='neutral'}){return h('aside',{'data-tone':tone},children)}",
    "index.d.ts": `import type {ReactNode} from 'react';
export interface CalloutProps {
/** Surface color. */
tone?: 'neutral' | 'accent';
children?: ReactNode;
}
/** Explain contextual information alongside a page. */
export declare function Callout(props: CalloutProps): ReactNode;`,
    "README.md":
      'Show contextual information.\n```tsx\n<Callout tone="neutral">Notice</Callout>\n```\n',
  };
  const manifest = (version: string, react = "^19.3.1") => ({
    name,
    version,
    type: "module",
    types: "./index.d.ts",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    peerDependencies: { react },
  });
  const projectFiles = (version: string) => ({
    "package.json": JSON.stringify({
      private: true,
      dependencies: { react: "19.3.1", [name]: version },
      devDependencies: { "@types/react": "19.3.0" },
    }),
  });
  try {
    await registry.publish(manifest("1.0.0"), files);
    await registry.publish(manifest("2.0.0"), {
      ...files,
      "index.js": files["index.js"].replace("neutral", "accent"),
    });
    await registry.publish(manifest("3.0.0", "^18.0.0"), files);
    await registry.publish(manifest("4.0.0"), {
      ...files,
      "README.md": "An undocumented release without runnable examples.",
    });
    const firstRoot = path.join(root, "first");
    const lock = await installProject(firstRoot, projectFiles("1.0.0"), [
      { name, registry: registry.base },
    ]);
    const admitted = await inspectLibrary(firstRoot, name, "1.0.0");
    expect(admitted.components).toHaveLength(1);
    expect(admitted.components[0]).toMatchObject({
      name: "Callout",
      props: { tone: { type: "enum", options: ["neutral", "accent"] } },
      examples: [{ props: { tone: "neutral" }, children: "Notice" }],
    });
    expect(admitted.components[0].provenance).toContain("README");
    const nextRoot = path.join(root, "next");
    await installProject(nextRoot, projectFiles("2.0.0"), [
      { name, registry: registry.base },
    ]);
    expect(
      (await inspectLibrary(nextRoot, name, "2.0.0")).components[0].version,
    ).toBe("2.0.0");
    const restored = await installProject(
      path.join(root, "restored"),
      { ...projectFiles("1.0.0"), "package-lock.json": lock },
      [{ name, registry: registry.base }],
    );
    expect(JSON.parse(restored).packages["node_modules/" + name].version).toBe(
      "1.0.0",
    );
    await expect(
      installProject(path.join(root, "peers"), projectFiles("3.0.0"), [
        { name, registry: registry.base },
      ]),
    ).rejects.toThrow("peer");
    const gapRoot = path.join(root, "gap");
    await installProject(gapRoot, projectFiles("4.0.0"), [
      { name, registry: registry.base },
    ]);
    await expect(inspectLibrary(gapRoot, name, "4.0.0")).rejects.toMatchObject({
      status: 422,
      detail: expect.arrayContaining([
        expect.stringContaining("runnable documented example"),
      ]),
    });
    registry.withdraw(name, "1.0.0");
    process.env.npm_config_cache = path.join(root, "fresh-cache");
    await expect(
      installProject(
        path.join(root, "unavailable"),
        { ...projectFiles("1.0.0"), "package-lock.json": lock },
        [{ name, registry: registry.base }],
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    if (prior === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = prior;
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
