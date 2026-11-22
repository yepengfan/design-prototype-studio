import { promises as fs } from "node:fs";
import { dataDir } from "../../playwright.config.js";

/**
 * Clears the Studio's data before the suite so a run cannot pass by exercising
 * the previous run's prototype or reading its briefing.
 */
export default async function globalSetup(): Promise<void> {
  await fs.rm(dataDir, { recursive: true, force: true });
}
