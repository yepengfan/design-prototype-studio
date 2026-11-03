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

it("service shutdown cancels a held admission install before its directories are removed", async () => {
  const { createApp } = await import("../server/app");
  const { createServer } = await import("node:http");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-admission-shutdown-"));
  const registry = await registryFixture(root);
  const prior = process.env.npm_config_userconfig, cache = process.env.npm_config_cache;
  process.env.npm_config_userconfig = registry.config;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const studio = await createApp({root:path.join(root,"studio"),origin,ai:{async generate(){throw new Error("No model requests in this test");},async cancel(){},close(){}}});
  server.on("request",studio.app);
  try {
    const name = "@studio-test/held-admission";
    await registry.publish({name,version:"1.0.0",main:"index.js"},{"index.js":"module.exports={};"});
    const metadata = await (await fetch(registry.base+"/"+encodeURIComponent(name),{headers:{Authorization:"Bearer synthetic-local-fixture"}})).json();
    const dist = metadata.versions["1.0.0"].dist;
    const project = blankProject("Admission shutdown");
    project.files["package.json"] = JSON.stringify({name:"admission-shutdown",version:"1.0.0",private:true,dependencies:{[name]:"1.0.0"}});
    project.files["package-lock.json"] = JSON.stringify({name:"admission-shutdown",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"admission-shutdown",version:"1.0.0",dependencies:{[name]:"1.0.0"}},["node_modules/"+name]:{version:"1.0.0",resolved:dist.tarball,integrity:dist.integrity}}});
    const accepted = await studio.store.create(project.manifest,project.files);
    process.env.npm_config_cache = path.join(root,"uncached-install");
    const secret = (await (await fetch(origin+"/api/session")).json()).secret;
    registry.hold();
    const request = fetch(origin+`/api/projects/${accepted.state.id}/library`,{method:"POST",headers:{"Content-Type":"application/json","X-Studio-Session":secret},body:JSON.stringify({base:accepted.snapshot.id,name,version:"1.0.0",registry:registry.base,trust:true})});
    await expect.poll(()=>registry.pendingRequests(),{timeout:15000,interval:20}).toBeGreaterThan(0);
    await studio.close();
    const response = await request;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("cancelled");
    expect((await studio.store.get(accepted.state.id)).state.head).toBe(accepted.snapshot.id);
    await expect.poll(()=>registry.pendingRequests(),{timeout:5000}).toBe(0);
    await fs.rm(path.join(root,"studio","admissions"),{recursive:true,force:true});
  } finally {
    await studio.close(); server.closeAllConnections(); await new Promise<void>((resolve)=>server.close(()=>resolve())); await registry.close();
    if(prior===undefined)delete process.env.npm_config_userconfig;else process.env.npm_config_userconfig=prior;
    if(cache===undefined)delete process.env.npm_config_cache;else process.env.npm_config_cache=cache;
    await fs.rm(root,{recursive:true,force:true});
  }
},30000);
