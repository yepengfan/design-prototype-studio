import { e2eFixture } from "../e2e-fixture";
import { accountFreeAI } from "../account-free-ai";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../../server/app";
import { registryFixture } from "../registry";
import { prototypeFixture } from "../prototype";
import { exportArchive, readArchive } from "../../server/core/archive";
import { digest, writeFiles } from "../../server/core/files";
import { parseRequirements } from "../../server/core/requirements";
import { installProject } from "../../server/core/libraries";
import { runCommand } from "../../server/core/process";
test("fresh source handoff preserves controllers, providers, styles and all scenario outcomes across import/edit/export", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const root = await e2eFixture("handoff-");
  const registry = await registryFixture(root);
  const previous = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({
    ai: accountFreeAI,
    root: path.join(root, "studio"),
    origin,
  });
  server.on("request", studio.app);
  const session = await (await fetch(origin + "/api/session")).json();
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Session": session.secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  try {
    const prototype = await prototypeFixture(
      path.join(root, "original"),
      registry.base,
    );
    const archive = exportArchive(prototype.files, prototype.manifest);
    const inspection = await request("/import", {
      archive: archive.toString("base64"),
    });
    expect(inspection.diagnostics).toEqual([]);
    const imported = await request("/import", {
      archive: archive.toString("base64"),
      confirm: true,
    });
    const id = imported.state.id;
    for (const file of [
      "src/pages/Page.tsx",
      "src/providers.tsx",
      "src/data/notices.ts",
      "src/styles.css",
      "src/Notice.stories.tsx",
    ])
      expect(digest(imported.snapshot.files[file])).toBe(
        digest(prototype.files[file]),
      );
    const report = await request(`/projects/${id}/quality`, {});
    expect(
      report.results.map((r: any) => ({ name: r.name, failures: r.failures })),
    ).toEqual(report.results.map((r: any) => ({ name: r.name, failures: [] })));
    expect(report.ready).toBe(true);
    await fs.writeFile(test.info().outputPath("handoff-quality.json"), JSON.stringify(report, null, 2));
    const snapshot = (await studio.store.get(id)).snapshot;
    const storybook = await studio.previews.startStorybook(snapshot);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const exportName of ["Success", "Replacement"]) {
      const story = storybook.stories.find((s) => s.exportName === exportName)!;
      await page.goto(
        storybook.url + "/iframe.html?id=" + story.id + "&viewMode=story",
      );
      await expect(
        page.getByRole("heading", { name: "Notice workspace" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByRole("alert")).toHaveText("Name is required");
      await page.getByRole("textbox", { name: "Your name" }).fill("Alex");
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(
        page.getByRole("status", { name: "Acknowledgement" }),
      ).toHaveText("Acknowledged Alex");
      await page.screenshot({
        path: test.info().outputPath(exportName + ".png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    expect(errors).toEqual([]);
    for (const exportName of ["Success", "Replacement"]) {
      const reactSnapshot = structuredClone(snapshot);
      reactSnapshot.manifest.pages[0].previewStory = `src/Notice.stories.tsx#${exportName}`;
      const react = await studio.previews.start(reactSnapshot);
      try {
        await page.goto(react.url);
        await expect(page.getByRole("heading", { name: "Notice workspace" })).toBeVisible();
        await page.getByRole("button", { name: "Acknowledge" }).click();
        await expect(page.getByRole("alert")).toHaveText("Name is required");
        await page.getByRole("textbox", { name: "Your name" }).fill("Alex");
        await page.getByRole("button", { name: "Acknowledge" }).click();
        await expect(page.getByRole("status", { name: "Acknowledgement" })).toHaveText("Acknowledged Alex");
        await page.screenshot({ path: test.info().outputPath(`React-${exportName}.png`), fullPage: true, animations: "disabled" });
      } finally { studio.previews.stop(react.id); }
    }
    expect(errors).toEqual([]);
    await page.close();
    studio.previews.stop(storybook.id);
    const data = await request(`/projects/${id}`);
    const main = data.outline[0].nodes.find((n: any) => n.tag === "main");
    await request(`/projects/${id}/edit`, {
      base: data.snapshot.id,
      page: "page",
      edit: {
        anchor: main.id,
        sourceHash: data.outline[0].hash,
        operation: "style",
        value: { padding: 48 },
      },
    });
    const response = await fetch(origin + `/api/projects/${id}/export`, {
      headers: { "X-Studio-Session": session.secret },
    });
    expect(response.ok).toBe(true);
    const exported = readArchive(Buffer.from(await response.arrayBuffer()));
    expect(exported["src/data/notices.ts"]).toBe(
      prototype.files["src/data/notices.ts"],
    );
    expect(exported["src/Notice.stories.tsx"]).toBe(
      prototype.files["src/Notice.stories.tsx"],
    );
    expect(exported["src/providers.tsx"]).toBe(
      prototype.files["src/providers.tsx"],
    );
    const fresh = path.join(root, "fresh-install");
    await installProject(fresh, exported, prototype.manifest.libraries);
    const built = await runCommand("npm", ["run", "build"], fresh);
    expect(built.code, built.stdout + built.stderr).toBe(0);
    const portProbe = createServer();
    await new Promise<void>((resolve) =>
      portProbe.listen(0, "127.0.0.1", resolve),
    );
    const scenarioAddress = portProbe.address();
    if (!scenarioAddress || typeof scenarioAddress === "string")
      throw new Error("Scenario port did not bind");
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const scenarios = await runCommand(
      "npm",
      ["run", "test:scenarios"],
      fresh,
      {
        env: {
          STUDIO_STORYBOOK_PORT: String(scenarioAddress.port),
          STUDIO_CHROME: process.env.STUDIO_CHROME,
          CI: "1",
        },
        timeout: 120_000,
      },
    );
    expect(scenarios.code, scenarios.stdout + scenarios.stderr).toBe(0);
    await fs.writeFile(test.info().outputPath("exported-scenarios.log"), scenarios.stdout + scenarios.stderr);
    const again = await request("/import", {
      archive: exportArchive(
        exported,
        JSON.parse(exported["studio.project.json"]),
      ).toString("base64"),
      confirm: true,
    });
    expect(again.snapshot.files["src/pages/Page.tsx"]).toBe(
      exported["src/pages/Page.tsx"],
    );
    const reopened = await request(`/projects/${again.state.id}`);
    const reopenedMain = reopened.outline[0].nodes.find((node: any) => node.tag === "main");
    const editedAgain = await request(`/projects/${again.state.id}/edit`, {
      base: reopened.snapshot.id, page: "page",
      edit: { anchor: reopenedMain.id, sourceHash: reopened.outline[0].hash, operation: "style", value: { padding: 56 } },
    });
    const secondResponse = await fetch(origin + `/api/projects/${again.state.id}/export`, { headers: { "X-Studio-Session": session.secret } });
    expect(secondResponse.ok).toBe(true);
    const secondExport = readArchive(Buffer.from(await secondResponse.arrayBuffer()));
    expect(secondExport["src/pages/Page.tsx"]).toBe(editedAgain.snapshot.files["src/pages/Page.tsx"]);
    expect(secondExport["src/pages/Page.tsx"]).not.toBe(exported["src/pages/Page.tsx"]);
    for (const file of ["src/data/notices.ts", "src/providers.tsx", "src/styles.css", "src/Notice.stories.tsx", "requirements/notices.feature", "package-lock.json"])
      expect(secondExport[file]).toBe(exported[file]);
    await fs.writeFile(test.info().outputPath("roundtrip.json"), JSON.stringify({ first: imported.snapshot.id, reopened: reopened.snapshot.id, edited: editedAgain.snapshot.id, retainedFiles: ["src/data/notices.ts", "src/providers.tsx", "src/styles.css", "src/Notice.stories.tsx", "requirements/notices.feature", "package-lock.json"] }, null, 2));
    // Deliberately wrong behavior must not pass by putting Then before When.
    const wrong = structuredClone(prototype);
    wrong.files["requirements/notices.feature"] = "Feature: Keep a name\nScenario: Name remains Alex\nGiven the notice workspace is open\nWhen I enter Jordan\nThen the name is Alex\n";
    wrong.files["src/pages/Page.tsx"] = wrong.files["src/pages/Page.tsx"].replace("const[name,setName]=useState('')", "const[name,setName]=useState('Alex')");
    const requirement = parseRequirements(wrong.files, wrong.manifest.scope).scenarios[0];
    wrong.manifest.scenarios = [{scenario:requirement.id,page:"page",story:"src/Notice.stories.tsx#Success",fixture:"src/data/notices.ts",accepted:true,steps:[
      {step:"1",action:"visible",role:"heading",name:"Notice workspace"},
      {step:"3",action:"value",role:"textbox",name:"Your name",value:"Alex"},
      {step:"2",action:"fill",role:"textbox",name:"Your name",value:"Jordan"},
    ]}];
    const wrongProject = await studio.store.create(wrong.manifest, wrong.files);
    const failed = await request(`/projects/${wrongProject.state.id}/quality`, {});
    expect(failed.ready).toBe(false);
    expect(failed.results.flatMap((result: {failures:string[]}) => result.failures).join("\n")).toContain("Jordan");
    const wrongExport = readArchive(exportArchive(wrong.files, wrong.manifest));
    await writeFiles(fresh, wrongExport);
    const failedExport = await runCommand("npm", ["run", "test:scenarios"], fresh, {env:{STUDIO_STORYBOOK_PORT:String(scenarioAddress.port),STUDIO_CHROME:process.env.STUDIO_CHROME,CI:"1"},timeout:120000});
    expect(failedExport.code).not.toBe(0);
    expect(failedExport.stdout + failedExport.stderr).toContain("Jordan");
    expect(failedExport.stdout).toContain("1 failed");
    await fs.writeFile(test.info().outputPath("scenario-order-rejected.json"), JSON.stringify(failed, null, 2));
    await fs.writeFile(test.info().outputPath("exported-scenario-order-rejected.log"), failedExport.stdout + failedExport.stderr);
  } finally {
    await studio.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (previous === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
