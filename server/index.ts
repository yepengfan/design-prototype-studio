import path from "node:path";
import { createApp } from "./app.js";
import { config } from "./config.js";

// A production build serves the Studio itself; in development Vite does.
const app = await createApp({ clientDist: path.join(config.repoRoot, "dist", "client") });

app.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`Design Prototype Studio API on http://localhost:${config.port}\n`);
});
