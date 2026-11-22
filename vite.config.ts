import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.PORT ?? 5174);

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      // shadcn publishes its class-name helper as an import alias.
      cn: path.join(root, "src", "lib", "utils.ts"),
    },
  },
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: Number(process.env.STUDIO_CLIENT_PORT ?? 5173),
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/preview": `http://127.0.0.1:${apiPort}`,
    },
  },
});
