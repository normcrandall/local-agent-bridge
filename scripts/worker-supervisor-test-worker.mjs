#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const id = process.argv[2];
if (process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT) {
  await writeFile(join(process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT, `${id}.environment.json`), `${JSON.stringify({
    firstHostOnlySecret: process.env.FIRST_HOST_ONLY_SECRET || null,
  })}\n`);
}

setInterval(() => {}, 60_000);
