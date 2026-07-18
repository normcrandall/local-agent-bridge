#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { supervisorEndpoint } from "../../src/worker-supervisor-protocol.mjs";

const runtimeRoot = resolve(process.env.BRIDGE_RUNTIME_ROOT);
const stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR);
const endpoint = supervisorEndpoint(stateDirectory);
const supervisorId = randomUUID();
const startedAt = new Date().toISOString();

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);
if (process.platform !== "win32") await rm(endpoint, { force: true });

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    if (request.type === "ping") {
      socket.end(`${JSON.stringify({ ok: true, result: {
        supervisorId,
        supervisorPid: process.pid,
        protocol: 0,
        startedAt,
        runtimeRoot,
        stateDirectory,
        ready: true,
      } })}\n`);
    } else {
      socket.end(`${JSON.stringify({ ok: false, error: `Unknown supervisor request: ${request.type}` })}\n`);
    }
  });
});

await new Promise((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(endpoint, resolvePromise);
});
if (process.platform !== "win32") await chmod(endpoint, 0o600);
await writeFile(resolve(stateDirectory, "supervisor.json"), `${JSON.stringify({
  protocol: 0,
  supervisorId,
  pid: process.pid,
  startedAt,
  runtimeRoot,
  stateDirectory,
}, null, 2)}\n`, { mode: 0o600 });

async function shutdown() {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (process.platform !== "win32") await rm(endpoint, { force: true });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
