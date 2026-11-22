import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.STUDIO_E2E_PORT ?? 5275);

/** Each run starts from an empty Studio so the flow is exercised end to end. */
export const dataDir = path.join(root, ".studio", "e2e");
export const deliveryDir = path.join(dataDir, "deliveries");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm start",
    url: `http://127.0.0.1:${port}/api/presets`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(port),
      STUDIO_DATA_DIR: dataDir,
      STUDIO_DELIVERY_DIR: deliveryDir,
    },
  },
});
