import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import express from "express";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
const port = Number(process.env.STUDIO_PORT ?? 4310);
const origin = `http://127.0.0.1:${port}`;
const root =
  process.env.STUDIO_DATA ??
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Design Prototype Studio",
  );
const studio = await createApp({ root, origin });
const appRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.argv.includes("--production"))
  studio.app.use(express.static(path.join(appRoot, "dist/client")));
else {
  const vite = await createViteServer({
    root: appRoot,
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  studio.app.use(vite.middlewares);
}
const server = createServer(studio.app);
server.listen(port, "127.0.0.1", () =>
  console.log(`Studio is ready at ${origin}`),
);
const close = async () => {
  await studio.close();
  server.close(() => process.exit());
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
