import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("starts the API in Node's native ESM runtime", async () => {
  const dataDir = await fs.mkdtemp(path.resolve(".studio-startup-"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", `
        import { createApp } from "./server/app.ts";
        const app = await createApp();
        const server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        try {
          const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/presets");
          if (!response.ok) throw new Error("API returned " + response.status);
          console.log(JSON.stringify(await response.json()));
        } finally {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      `,
    ], { env: { ...process.env, STUDIO_DATA_DIR: dataDir }, timeout: 20_000 });
    const payload = JSON.parse(stdout) as { presets: unknown };
    expect(payload.presets).toEqual(expect.any(Array));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
