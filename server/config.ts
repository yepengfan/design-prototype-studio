import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root. Studio data lives inside it so Node resolves shared packages. */
export const repoRoot = path.resolve(here, "..");

export const config = {
  repoRoot,
  /**
   * Generated projects live under the repository so that `node_modules`
   * resolution and Tailwind's CSS imports reach the Studio's own packages.
   */
  dataDir: process.env.STUDIO_DATA_DIR
    ? path.resolve(process.env.STUDIO_DATA_DIR)
    : path.join(repoRoot, ".studio"),
  port: Number(process.env.PORT ?? 5174),
  /** Directory that receives annotation batches handed to a review agent. */
  deliveryDir: process.env.STUDIO_DELIVERY_DIR
    ? path.resolve(process.env.STUDIO_DELIVERY_DIR)
    : undefined,
  /**
   * Shell command that receives an annotation batch on stdin and answers on
   * stdout, for example `cursor-agent -p`. Falls back to file delivery.
   */
  agentCommand: process.env.STUDIO_AGENT_COMMAND,
  agentCommandTimeoutMs: Number(process.env.STUDIO_AGENT_TIMEOUT_MS ?? 120_000),
  /** Seconds a fetched registry payload stays valid on disk. */
  registryCacheSeconds: Number(process.env.STUDIO_REGISTRY_CACHE_SECONDS ?? 86_400),
  networkTimeoutMs: Number(process.env.STUDIO_NETWORK_TIMEOUT_MS ?? 30_000),
};

export const paths = {
  projects: () => path.join(config.dataDir, "projects"),
  project: (id: string) => path.join(config.dataDir, "projects", id),
  projectFile: (id: string) => path.join(config.dataDir, "projects", id, "project.json"),
  projectSource: (id: string) => path.join(config.dataDir, "projects", id, "src"),
  projectDist: (id: string) => path.join(config.dataDir, "projects", id, "dist"),
  registryCache: () => path.join(config.dataDir, "registry-cache"),
  deliveries: () => config.deliveryDir ?? path.join(config.dataDir, "deliveries"),
};
