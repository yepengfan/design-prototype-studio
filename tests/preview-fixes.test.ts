import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config, paths } from "../server/config.js";
import type { Project, RegistrySourceSpec } from "../server/contracts.js";
import { buildPreview } from "../server/preview.js";
import { resolveTheme } from "../server/sources/theme.js";
import { ordersGherkin } from "./fixtures.js";

/** Only the parts of a registry item these tests rewrite on disk. */
type RegistryItem = {
  cssVars?: { light?: Record<string, string>; dark?: Record<string, string> };
  css?: Record<string, unknown>;
  files: { content: string }[];
};

vi.mock("../server/dependencies.js", () => ({ ensurePackages: vi.fn() }));
const { createApp } = await import("../server/app.js");
const previousDataDir = config.dataDir;
let server: Server;
let origin: string;
let registry: string;
let spec: RegistrySourceSpec;

beforeAll(async () => {
  config.dataDir = await fs.mkdtemp(path.resolve(".studio-preview-fixes-"));
  registry = path.join(config.dataDir, "registry");
  await fs.cp(path.resolve("tests/fixtures/registry"), registry, { recursive: true });
  spec = { kind: "registry", url: pathToFileURL(registry).toString() };
  server = (await createApp()).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(config.dataDir, { recursive: true, force: true });
  config.dataDir = previousDataDir;
});

async function call(route: string, method = "GET", body?: unknown, status = 200): Promise<{ project: Project }> {
  const response = await fetch(`${origin}${route}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as { project: Project };
}

async function setup() {
  const { project } = await call("/api/projects", "POST", { name: "Preview" }, 201);
  const base = `/api/projects/${project.id}`;
  const { project: imported } = await call(`${base}/systems`, "POST", { name: "Custom", spec }, 201);
  const request = { gherkin: ordersGherkin, templateId: imported.systems[0]!.templates[0]!.id };
  return { base, request, id: project.id };
}

async function preview(id: string) {
  const url = `${origin}/preview/${id}/index.html`;
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const document = new JSDOM(html, { url }).window.document;
  const script = await fetch(document.querySelector("script")!.src);
  const stylesheet = await fetch(document.querySelector('link[rel="stylesheet"]')!.getAttribute("href")!.replace(/^\.\//, `${origin}/preview/${id}/`));
  expect(script.status).toBe(200);
  expect(stylesheet.status).toBe(200);
  return { html, javascript: await script.text(), css: await stylesheet.text() };
}

describe("preview publication through the Studio API", () => {
  it("builds a custom registry with no theme options", async () => {
    const { base, id, request } = await setup();
    await call(`${base}/generate`, "POST", request);
    const built = await preview(id);
    expect(built.javascript).toContain("A-101");
    expect(built.css.length).toBeGreaterThan(0);
  });

  it("carries the template and component published tokens into compiled CSS", async () => {
    const templateFile = path.join(registry, "console-01.json");
    const componentFile = path.join(registry, "button.json");
    const template = JSON.parse(await fs.readFile(templateFile, "utf8")) as RegistryItem;
    const component = JSON.parse(await fs.readFile(componentFile, "utf8")) as RegistryItem;
    template.cssVars = { light: { background: "#123456", foreground: "#fedcba" }, dark: { background: "#654321" } };
    component.cssVars = { light: { border: "#abcdef", ring: "#112233" } };
    await fs.writeFile(templateFile, JSON.stringify(template));
    await fs.writeFile(componentFile, JSON.stringify(component));
    const { base, id, request } = await setup();
    await call(`${base}/generate`, "POST", request);
    const built = await preview(id);
    for (const value of ["#123456", "#fedcba", "#654321", "#abcdef", "#112233"])
      expect(built.css).toContain(value);
  });

  it("preserves the served preview and queued notes after either compiler fails", async () => {
    const { base, id, request } = await setup();
    const { project: initial } = await call(`${base}/generate`, "POST", request);
    await call(`${base}/annotations`, "POST", {
      pageId: initial.pages[0]!.id, note: "Keep this context",
      target: { label: "Show overdue", domPath: "button", anchor: "control-show-overdue" },
    }, 201);
    const { project: before } = await call(base);
    const served = await preview(id);
    const buttonFile = path.join(registry, "button.json");
    const button = JSON.parse(await fs.readFile(buttonFile, "utf8")) as RegistryItem;
    const original = structuredClone(button);
    button.files[0]!.content = "export function Button( { invalid";
    await fs.writeFile(buttonFile, JSON.stringify(button));
    const renamed = { ...request, gherkin: request.gherkin.replace("the Orders page", "the Renamed page") };
    await call(`${base}/generate`, "POST", renamed, 422);
    expect(await preview(id)).toEqual(served);
    expect((await call(base)).project).toEqual(before);
    original.css = { '@import "missing-preview-theme-package"': {} };
    await fs.writeFile(buttonFile, JSON.stringify(original));
    await call(`${base}/generate`, "POST", renamed, 422);
    expect(await preview(id)).toEqual(served);
    expect((await call(base)).project).toEqual(before);
    delete original.css;
    await fs.writeFile(buttonFile, JSON.stringify(original));
    const { project: regenerated } = await call(`${base}/generate`, "POST", renamed);
    expect(regenerated.pages[0]!.title).toBe("Renamed");
    expect(regenerated.pages[0]!.id).toBe(before.pages[0]!.id);
    expect(regenerated.annotations).toEqual(before.annotations);
    expect(await preview(id)).not.toEqual(served);
    expect(await fs.readdir(paths.project(id))).not.toContain("preview-index.html");
  });

  it.each(["no tokens", "partial tokens", "failed color fetch", "theme item"])("compiles with %s", async (mode) => {
    const themeSpec = { ...spec };
    if (mode === "failed color fetch") themeSpec.colorsUrl = pathToFileURL(path.join(registry, "absent.json")).toString();
    if (mode === "theme item") themeSpec.themeItem = "button";
    const theme = await resolveTheme(themeSpec, mode === "partial tokens"
      ? [{ name: "partial", cssVars: { light: { background: "#123456" } } }] : []);
    await buildPreview(`theme-${mode.replaceAll(" ", "-")}`, {
      files: [{ path: "src/app/page.tsx", content: 'export default function Page() { return <p>Theme preview</p> }' }],
      styles: theme.css, entryModule: "@/app/page",
    });
    if (mode === "failed color fetch") expect(theme.warnings).toHaveLength(1);
  });
});
