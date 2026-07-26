import assert from "node:assert/strict";
import { createAgentPool } from "../src/agent-pool.mjs";

const sha = "a".repeat(40);
const baseBuilder = {
  repository: "owner/repo",
  expectedLogin: "compat-builder[bot]",
  headSha: sha,
  headRef: "codex/feature",
  baseRef: "main",
  allowedOperations: ["ensure_pull_request", "merge"],
};

const roles = {
  roles: {
    builder: { expectedLogin: "compat-builder[bot]", appId: "1" },
    writers: {
      claude: { expectedLogin: "claude-writer[bot]", appId: "2" },
      codex: { expectedLogin: "codex-writer[bot]", appId: "3" },
      antigravity: { expectedLogin: "gemini-writer[bot]", appId: "4" },
    },
    reviewers: {},
  },
  mergePolicy: {},
  github: { mergeEnforcement: "broker" },
};

function credential(provider, sequence = 1) {
  const selected = provider
    ? { claude: ["2", "claude-writer[bot]"], codex: ["3", "codex-writer[bot]"], antigravity: ["4", "gemini-writer[bot]"] }[provider]
    : ["1", "compat-builder[bot]"];
  return {
    token: `ghs_test_${sequence}`,
    verifiedLogin: selected[1],
    expectedLogin: selected[1],
    appId: selected[0],
    installationId: Number(selected[0]) + 100,
    permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    roleLabel: provider ? `writer:${provider}` : "builder",
    provider: provider || null,
  };
}

function fakeProviderClient(message = "work complete") {
  return {
    async connect() {},
    async listTools() { return { tools: [{ name: "work" }] }; },
    async callTool(request) {
      return {
        content: [{ type: "text", text: message }],
        structuredContent: request.name.includes("antigravity")
          ? { conversationId: "00000000-0000-4000-8000-000000000001" }
          : { threadId: "thread-1" },
      };
    },
    async close() {},
  };
}

{
  let request;
  const client = fakeProviderClient();
  client.callTool = async (value) => {
    request = value;
    return { content: [{ type: "text", text: "done" }], structuredContent: { threadId: "thread-1" } };
  };
  const pool = createAgentPool({
    root: process.cwd(), workspace: process.cwd(), githubBuilder: baseBuilder,
    createCredential: ({ writerProvider }) => credential(writerProvider),
    inspectAppRoles: async () => roles,
    clientFactory: () => client, transportFactory: () => ({}),
  });
  const result = await pool.send({ agent: "codex", prompt: "deliver", mode: "work", browser: false });
  assert.equal(request.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_EXPECTED_LOGIN"], "codex-writer[bot]");
  assert.equal(request.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_WRITER_PROVIDER"], "codex");
  assert.equal(request.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_ALLOWED_OPERATIONS"], "ensure_pull_request");
  assert.equal(request.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_OPERATIONS_BOUND"], "1");
  assert.equal(result.metadata.writerAuthority.requestedLogin, "compat-builder[bot]");
  assert.equal(result.metadata.writerAuthority.resolvedLogin, "codex-writer[bot]");
  assert.equal(result.metadata.writerAuthority.rebindReason, "provider_writer_selection");
  assert.deepEqual(result.metadata.writerAuthority.removedOperations, ["merge"]);
  await pool.close();
}

{
  const pool = createAgentPool({
    root: process.cwd(), workspace: process.cwd(),
    githubBuilder: { ...baseBuilder, allowedOperations: ["merge"] },
    createCredential: ({ writerProvider }) => credential(writerProvider),
    inspectAppRoles: async () => roles,
    clientFactory: () => fakeProviderClient(), transportFactory: () => ({}),
  });
  await assert.rejects(
    pool.send({ agent: "codex", prompt: "merge", mode: "work", browser: false }),
    /cannot be authorized for merge alone/,
  );
  await pool.close();
}

{
  let attempts = 0;
  const pool = createAgentPool({
    root: process.cwd(), workspace: process.cwd(), githubBuilder: baseBuilder,
    createCredential: ({ writerProvider }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient mint failure");
      return credential(writerProvider, attempts);
    },
    inspectAppRoles: async () => roles,
    clientFactory: () => fakeProviderClient(), transportFactory: () => ({}),
  });
  await assert.rejects(
    pool.send({ agent: "codex", prompt: "deliver", mode: "work", browser: false }),
    /transient mint failure/,
  );
  await pool.send({ agent: "codex", prompt: "deliver", mode: "work", browser: false });
  assert.equal(attempts, 2, "a rejected writer-binding promise must be evicted so the next turn retries");
  await pool.close();
}

{
  let mints = 0;
  let builderOptions;
  const envelope = "---BEGIN BOUND_GITHUB_BUILDER---\n{\"operations\":[]}\n---END BOUND_GITHUB_BUILDER---";
  const pool = createAgentPool({
    root: process.cwd(), workspace: process.cwd(), githubBuilder: baseBuilder,
    createCredential: ({ writerProvider }) => credential(writerProvider, ++mints),
    inspectAppRoles: async () => roles,
    builderClientFactory: (options) => {
      builderOptions = options;
      return { async reviewThreads() { return []; } };
    },
    clientFactory: () => fakeProviderClient(envelope), transportFactory: () => ({}),
  });
  await pool.send({ agent: "antigravity", prompt: "deliver", mode: "work", browser: false });
  assert.equal(builderOptions.token, undefined, "the in-process builder must not retain a static installation token");
  assert.equal(typeof builderOptions.getToken, "function");
  const first = await builderOptions.getToken();
  const second = await builderOptions.getToken();
  assert.notEqual(first.token, second.token, "each builder client token request must mint a fresh installation token");
  assert.equal(mints, 3, "one metadata mint plus two fresh operation mints are expected");
  await pool.close();
}

{
  const pool = createAgentPool({
    root: process.cwd(), workspace: process.cwd(),
    githubBuilder: { ...baseBuilder, expectedLogins: { codex: "some-other-writer[bot]" } },
    createCredential: ({ writerProvider }) => credential(writerProvider),
    inspectAppRoles: async () => roles,
    clientFactory: () => fakeProviderClient(), transportFactory: () => ({}),
  });
  await assert.rejects(
    pool.send({ agent: "codex", prompt: "deliver", mode: "work", browser: false }),
    /does not match the bound authorization/,
  );
  await pool.close();
}

console.log("Writer App routing tests passed: provider selection, merge isolation, strict pins, retry, fresh tokens, and authority receipts.");
