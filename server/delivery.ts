import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config, paths } from "./config.js";
import type { Annotation, AnnotationBatch, Project } from "./contracts.js";
import { StudioError } from "./errors.js";

export type DeliveryResult = AnnotationBatch["delivery"];

/**
 * Hands a batch of annotations to a review agent and returns only once that
 * agent has answered.
 *
 * The briefing is written to disk first so the request is auditable, but a file
 * on disk is not a delivery: without a configured agent this throws, which
 * leaves the notes queued for another attempt.
 */
export async function deliverBatch(
  project: Project,
  batchId: string,
  annotations: Annotation[],
): Promise<DeliveryResult> {
  if (annotations.length === 0)
    throw new StudioError("Queue at least one note before sending a batch for review.");

  const directory = paths.deliveries();
  await fs.mkdir(directory, { recursive: true });
  const briefing = renderBriefing(project, batchId, annotations);
  const briefingFile = path.join(directory, `${batchId}.md`);
  const dataFile = path.join(directory, `${batchId}.json`);
  await fs.writeFile(briefingFile, briefing);
  await fs.writeFile(
    dataFile,
    JSON.stringify({ projectId: project.id, batchId, annotations }, null, 2),
  );

  if (!config.agentCommand)
    throw new StudioError(
      `No review agent is configured, so these notes cannot be sent. The briefing is ready at ${briefingFile}; set STUDIO_AGENT_COMMAND to the agent that should receive it and send again.`,
      503,
    );

  const reply = await runAgent(config.agentCommand, briefing);
  await fs.writeFile(path.join(directory, `${batchId}.reply.md`), reply);
  return {
    transport: "command",
    target: config.agentCommand,
    receipt: `${annotations.length} note${annotations.length === 1 ? "" : "s"} received by the review agent.`,
    reply,
  };
}

/** The briefing an agent receives: the page, the anchors and the notes. */
export function renderBriefing(project: Project, batchId: string, annotations: Annotation[]): string {
  const pages = new Map(project.pages.map((page) => [page.id, page]));
  const lines = [
    `# Prototype review request`,
    ``,
    `- Project: ${project.name}`,
    `- Batch: ${batchId}`,
    `- Design systems: ${project.systems.map((system) => `${system.name} (${system.origin})`).join(", ") || "none"}`,
    `- Template: ${project.selectedTemplateId ?? "none"}`,
    ``,
    `## Use case`,
    ``,
    "```gherkin",
    project.gherkin.trim(),
    "```",
    ``,
    `## Notes`,
    ``,
  ];

  for (const [index, annotation] of annotations.entries()) {
    const page = pages.get(annotation.pageId);
    lines.push(
      `${index + 1}. **${annotation.target.label}** - ${annotation.note}`,
      `   - Page: ${annotation.pageTitle}${page ? ` (${page.path})` : ""}`,
      `   - Anchor: ${annotation.target.anchor ?? "none"}`,
      `   - Selector: \`${annotation.target.domPath}\``,
      ``,
    );
  }

  return lines.join("\n");
}

async function runAgent(command: string, input: string): Promise<string> {
  const [program, ...args] = command.split(" ").filter(Boolean);
  if (!program) throw new StudioError("STUDIO_AGENT_COMMAND is set but empty.");

  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { timeout: config.agentCommandTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            new StudioError(
              `The review agent "${command}" failed: ${stderr.trim() || error.message}`,
              502,
            ),
          );
        if (!stdout.trim()) return reject(new StudioError("The review agent returned no reply.", 502));
        resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}
