#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const runtimeRoot = realpathSync(
  process.env.BRIDGE_RUNTIME_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);
const supervisor = spawn(process.execPath, [resolve(runtimeRoot, "scripts/collaboration-supervisor.mjs")], {
  cwd: runtimeRoot,
  env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot },
  detached: true,
  stdio: "ignore",
});
supervisor.unref();
