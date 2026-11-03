import { providerSetup, projectSpecifier } from "./providers.js";
import { readFileSync } from "node:fs";
import type { Files, Manifest } from "./contracts.js";

export const runtimeVersions = {
  eslint: "10.14.0",
  "@eslint/js": "10.0.1",
  "typescript-eslint": "8.72.1",
  react: "19.3.1",
  "react-dom": "19.3.1",
  vite: "8.3.5",
  "@vitejs/plugin-react": "6.2.1",
  typescript: "6.0.3",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  storybook: "10.6.5",
  "@playwright/test": "1.64.1",
  "@cucumber/gherkin": "42.0.1",
  "@cucumber/messages": "34.2.1",
  "@storybook/react-vite": "10.6.5",
};
export function blankProject(name: string): {
  files: Files;
  manifest: Manifest;
} {
  const manifest: Manifest = {
    schemaVersion: 1,
    generationState: "unstarted",
    name,
    pages: [
      {
        id: "page",
        title: "Untitled page",
        file: "src/pages/Page.tsx",
        export: "Page",
      },
    ],
    scope: [],
    libraries: [],
    scenarios: [],
    styles: [],
  };
  const files: Files = {
    "eslint.config.js": `import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(js.configs.recommended, ...ts.configs.recommended, {
  files: ["**/*.{ts,tsx}"],
  rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] }
});
`,
    "tests/scenarios.spec.ts": readFileSync(
      new URL("../templates/scenarios.spec.ts", import.meta.url),
      "utf8",
    ),
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";
const port = Number(process.env.STUDIO_STORYBOOK_PORT ?? 6006);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a local Storybook port between 1024 and 65535");
const url = "http://127.0.0.1:" + port;
export default defineConfig({ testDir: "./tests", use: { baseURL: url, viewport: { width: 1440, height: 1000 }, launchOptions: process.env.STUDIO_CHROME ? { executablePath: process.env.STUDIO_CHROME } : {} }, webServer: { command: "npm exec -- storybook dev --port " + port + " --host 127.0.0.1 --no-open --ci", url, reuseExistingServer: false }, workers: 1 });
`,
    "src/data/adapter.ts": readFileSync(
      new URL("../templates/adapter.ts", import.meta.url),
      "utf8",
    ),
    "package.json": JSON.stringify(
      {
        name: "studio-prototype",
        private: true,
        version: "1.0.0",
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "tsc --noEmit && vite build",
          lint: "eslint src --max-warnings 0",
          storybook: "storybook dev -p 6006 --host 127.0.0.1 --no-open",
          "build-storybook": "storybook build",
          "test:scenarios": "playwright test",
        },
        dependencies: {
          react: runtimeVersions.react,
          "react-dom": runtimeVersions["react-dom"],
        },
        devDependencies: Object.fromEntries(
          Object.entries(runtimeVersions).filter(
            ([name]) => !["react", "react-dom"].includes(name),
          ),
        ),
      },
      null,
      2,
    ),
    "src/pages/Page.tsx":
      'export function Page() {\n  return <main style={{ display: "flex", flexDirection: "column", gap: 24, padding: 40, minHeight: "100vh" }}></main>;\n}\n',
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          types: ["vite/client"],
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src", ".storybook", "vite.config.ts"],
      },
      null,
      2,
    ),
    "vite.config.ts":
      'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()], resolve: { dedupe: ["react", "react-dom"] } });\n',
    "index.html":
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Prototype</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ".storybook/main.ts":
      'import type { StorybookConfig } from "@storybook/react-vite";\nconst config: StorybookConfig = { framework: "@storybook/react-vite", stories: ["../src/**/*.stories.@(ts|tsx)"] };\nexport default config;\n',
    ".storybook/base-preview.tsx":
      'export default { parameters: { layout: "fullscreen" } };\n',
    ".storybook/preview.tsx": "// Studio preview\nexport default {};\n",
    "README.md":
      "# React prototype\n\nUse Node 22.18 or newer. Run `npm ci --ignore-scripts`, `npm run dev`, `npm run storybook`, `npm run build`, and `npm run lint`. Private dependencies require your own npm registry login.\n\nCanonical pages, controllers, styles, fixtures and requirements are included. Connect real data by implementing the typed query/operation adapter interfaces in `src/data`; keep page validation and layout in place. Every Gherkin example needs a scenario story and executable step bindings in `studio.project.json`. Studio checks are necessary; a designer must also accept the final visual experience.\n",
  };
  return { manifest, files: synchronizeRuntime(files, manifest) };
}
export function synchronizeRuntime(input: Files, manifest: Manifest): Files {
  const files = { ...input };
  files["studio.project.json"] = JSON.stringify(manifest, null, 2) + "\n";
  const preview = files[".storybook/preview.tsx"]
    ? ".storybook/preview.tsx"
    : files[".storybook/preview.ts"]
      ? ".storybook/preview.ts"
      : undefined;
  const managedPreview =
    manifest.sourceOrigin !== "legacy" &&
    files[".storybook/preview.tsx"]?.startsWith("// Studio preview");
  if (preview && !managedPreview)
    for (const style of manifest.styles) {
      const imported = new RegExp(
        `import\\s+["']${style.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      ).test(files[preview]);
      if (!imported)
        files[preview] =
          `import ${JSON.stringify(projectSpecifier(style, "../"))};\n` +
          files[preview];
    }
  if (managedPreview) {
    const provider = providerSetup(manifest.provider, "../");
    files[".storybook/preview.tsx"] =
      `// Studio preview\nimport type { Preview, Decorator } from "@storybook/react-vite";\nimport baseConfig from "./base-preview";\n${provider.imports}${manifest.styles.map((style) => `import ${JSON.stringify(projectSpecifier(style, "../"))};`).join("\n")}\nconst base: Preview = baseConfig;\nconst wrapper: Decorator = Story => ${provider.wrap("<Story />")};\nexport default { ...base, decorators: [...(base.decorators ?? []), wrapper] };\n`;
  }
  // Native projects own their generated launcher. Legacy launchers/configuration stay intact.
  if (
    !files["src/main.tsx"] ||
    (manifest.sourceOrigin !== "legacy" &&
      files["src/main.tsx"].startsWith("// Studio launcher"))
  ) {
    const page = manifest.pages[0];
    const provider = providerSetup(manifest.provider, "../");
    if (page)
      files["src/main.tsx"] =
        `// Studio launcher\nimport { createRoot } from 'react-dom/client';\nimport { ${page.export} as Page } from './${page.file.replace(/^src\//, "").replace(/\.tsx?$/, "")}';\n${manifest.styles.map((s) => `import ${JSON.stringify(projectSpecifier(s, "../"))};`).join("\n")}\n${provider.imports}createRoot(document.getElementById('root')!).render(${provider.wrap("<Page />")});\n`;
  }
  return files;
}
