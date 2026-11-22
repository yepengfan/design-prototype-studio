import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { config } from "../server/config.js";
import { deliverBatch } from "../server/delivery.js";
import type { Annotation, Project } from "../server/contracts.js";
import { ordersGherkin } from "./fixtures.js";

const reviewAgent = fileURLToPath(new URL("./fixtures/review-agent.mjs", import.meta.url));
const failingAgent = fileURLToPath(new URL("./fixtures/failing-agent.mjs", import.meta.url));

const annotation: Annotation = {
  id: "note-1",
  pageId: "page-1",
  pageTitle: "Orders",
  target: { anchor: "control-show-overdue", domPath: "button", label: "Show overdue" },
  note: "Call this Overdue only",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const project: Project = {
  id: "project-1",
  name: "Orders prototype",
  createdAt: "2026-01-01T00:00:00.000Z",
  systems: [],
  selectedSystemIds: [],
  gherkin: ordersGherkin,
  pages: [],
  annotations: [annotation],
  batches: [],
};

const previousDataDir = config.dataDir;
const previousDeliveryDir = config.deliveryDir;
const previousAgentCommand = config.agentCommand;

beforeAll(async () => {
  config.dataDir = await fs.mkdtemp(path.resolve(".studio-delivery-"));
  config.deliveryDir = undefined;
});

afterEach(() => {
  config.agentCommand = previousAgentCommand;
});

afterAll(async () => {
  await fs.rm(config.dataDir, { recursive: true, force: true });
  config.dataDir = previousDataDir;
  config.deliveryDir = previousDeliveryDir;
  config.agentCommand = previousAgentCommand;
});

describe("sending a batch to a review agent", () => {
  it("reports delivery only after the agent answers", async () => {
    config.agentCommand = `node ${reviewAgent}`;

    const delivery = await deliverBatch(project, "batch-ok", [annotation]);

    expect(delivery.transport).toBe("command");
    expect(delivery.receipt).toBe("1 note received by the review agent.");
    expect(delivery.reply).toContain("Reviewed batch batch-ok: 1 note(s) understood.");
  });

  it("refuses to send when no agent is configured, and says where the briefing is", async () => {
    config.agentCommand = undefined;

    await expect(deliverBatch(project, "batch-none", [annotation])).rejects.toThrow(
      /No review agent is configured/,
    );
  });

  it("refuses to send when the configured agent fails", async () => {
    config.agentCommand = `node ${failingAgent}`;

    await expect(deliverBatch(project, "batch-fail", [annotation])).rejects.toThrow(
      /review agent .* failed/,
    );
  });
});
