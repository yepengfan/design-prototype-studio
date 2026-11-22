#!/usr/bin/env node
// A real consumer of a review briefing, used so tests prove delivery by the
// agent's own answer rather than by a file appearing on disk. It reads the
// briefing on stdin and reports back what it understood.
import { readFileSync } from "node:fs";

const briefing = readFileSync(0, "utf8");
const notes = briefing.split("\n").filter((line) => /^\d+\. \*\*/.test(line));
const batch = /^- Batch: (.+)$/m.exec(briefing)?.[1] ?? "unknown";

process.stdout.write(`Reviewed batch ${batch}: ${notes.length} note(s) understood.\n`);
