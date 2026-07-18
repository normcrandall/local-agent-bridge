#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const id = process.argv[2];
if (process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT) {
  await writeFile(join(process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT, `${id}.environment.json`), `${JSON.stringify({
    firstHostOnlySecret: process.env.FIRST_HOST_ONLY_SECRET || null,
    bridgeRequiredSetting: process.env.AGENT_BRIDGE_TEST_REQUIRED || null,
    pathPresent: Boolean(process.env.PATH),
  })}\n`);
}

const changeTitleAfter = Number.parseInt(process.env.BRIDGE_SUPERVISOR_TEST_CHANGE_TITLE_MS || "", 10);
if (Number.isInteger(changeTitleAfter) && changeTitleAfter > 0) {
  setTimeout(() => { process.title = "agent-bridge-reused-process-identity"; }, changeTitleAfter).unref();
}

setInterval(() => {}, 60_000);
