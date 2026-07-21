import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

function validatedConversationId(value) {
  const id = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid Docker Model Runner conversation ID.");
  }
  return id;
}

export function dockerSessionDirectory(workspaceRoot, {
  stateRoot = resolve(homedir(), ".local/state/local-agent-bridge"),
} = {}) {
  const workspaceKey = createHash("sha256").update(resolve(workspaceRoot)).digest("hex");
  return resolve(stateRoot, "docker-sessions", workspaceKey);
}

export async function loadDockerSession(workspaceRoot, conversationId, options = {}) {
  const id = validatedConversationId(conversationId);
  const path = resolve(dockerSessionDirectory(workspaceRoot, options), `${id}.json`);
  try {
    const session = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(session.messages) || typeof session.cwd !== "string") {
      throw new Error("persisted session has an invalid shape");
    }
    return session;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Unknown Docker Model Runner conversation ${id}; start a new context-backed review instead of silently losing prior context.`);
    }
    throw new Error(`Unable to restore Docker Model Runner conversation ${id}: ${error.message}`);
  }
}

export async function saveDockerSession(workspaceRoot, conversationId, session, options = {}) {
  const id = validatedConversationId(conversationId);
  const directory = dockerSessionDirectory(workspaceRoot, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = resolve(directory, `${id}.json`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
