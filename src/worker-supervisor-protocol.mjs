import { createHash } from "node:crypto";
import { join } from "node:path";
import process from "node:process";

export function supervisorEndpoint(stateDirectory) {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\agent-bridge-${digest}`;
  }
  return join(stateDirectory, "supervisor.sock");
}
