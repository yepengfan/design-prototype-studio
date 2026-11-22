#!/usr/bin/env node
// Stands in for a review agent that cannot accept the batch, so tests can prove
// the notes stay queued when delivery does not succeed.
import { readFileSync } from "node:fs";

readFileSync(0, "utf8");
process.stderr.write("review queue unavailable\n");
process.exit(1);
