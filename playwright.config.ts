import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  outputDir: process.env.STUDIO_E2E_OUTPUT || "test-results",
  use: {
    baseURL: "http://127.0.0.1:4311",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.env.STUDIO_CHROME
      ? { executablePath: process.env.STUDIO_CHROME }
      : {},
  },
});
