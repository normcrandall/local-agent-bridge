import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

function validateConversationId(conversationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId || "")) {
    throw new Error("Invalid Ollama conversation ID.");
  }
  return conversationId;
}

export function ollamaSessionDirectory(workspaceRoot, {
  stateRoot = process.env.AGENT_BRIDGE_STATE_DIR || resolve(homedir(), ".local/state/local-agent-bridge"),
} = {}) {
  const workspaceKey = createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 24);
  return resolve(stateRoot, "ollama-sessions", workspaceKey);
}

export async function loadOllamaSession(workspaceRoot, conversationId, options = {}) {
  const id = validateConversationId(conversationId);
  const path = resolve(ollamaSessionDirectory(workspaceRoot, options), `${id}.json`);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value.messages) || typeof value.cwd !== "string") throw new Error("stored session is malformed");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Unknown Ollama conversation ${id}; start a new context-backed review instead of silently losing prior context.`);
    }
    throw new Error(`Unable to restore Ollama conversation ${id}: ${error.message}`);
  }
}

export async function saveOllamaSession(workspaceRoot, conversationId, session, options = {}) {
  const id = validateConversationId(conversationId);
  const directory = ollamaSessionDirectory(workspaceRoot, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `${id}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
