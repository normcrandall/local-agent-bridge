import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { antigravityToolRequest, claudeToolRequest, codexToolRequest, dockerToolRequest, ollamaToolRequest } from "./tool-requests.mjs";
import { parseReviewEnvelope, reviewEnvelopeInstructions } from "./review-envelope.mjs";
import { loadConfiguredFallbackModels } from "./model-fallbacks.mjs";
import { builderEnvelopeInstructions } from "./builder-envelope.mjs";
import { deliverBuilderEnvelope } from "./builder-delivery-repair.mjs";
import { configuredReviewerLogin, createInstallationToken, inspectGitHubAppRoles, sameGitHubAppLogin } from "./github-app-auth.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { readLatestReviewTrustEvidence } from "./github-review-threads.mjs";
import {
  localReviewPrompt,
  republishValidatedReview,
  resolveReviewPublication,
  reviewTrustRosterForPublication,
  submitReviewWithSummaryCompatibility,
} from "./review-publication.mjs";
import { resolveContainedHandoffPath } from "./handoff-path.mjs";
import {
  admitProviderCommands,
  assertProviderVerificationCapability,
  providerPermissionDecisionForRequest,
  providerVerificationPlanForRequest,
} from "./verification-allowlist.mjs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { LOCAL_REVIEW_PREFLIGHT_BUDGET_MS } from "./local-review-priority.mjs";

function textFrom(result) {
  const structured = result.structuredContent || {};
  const message = structured.result || structured.content;
  if (typeof message === "string" && message.trim()) return message;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function sessionFrom(agent, result) {
  const structured = result.structuredContent || {};
  if (agent === "claude") return structured.sessionId || null;
  if (agent === "codex") return structured.threadId || null;
  return structured.conversationId || null;
}

function workspaceHead(workspace) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export function providerFallbackSlots(agent, modelFallbacks = {}) {
  if (!["claude", "codex", "antigravity", "ollama", "docker"].includes(agent)) return 0;
  if (Array.isArray(modelFallbacks[agent])) return modelFallbacks[agent].length;
  try {
    return loadConfiguredFallbackModels(agent).length;
  } catch {
    // The provider adapter emits the visible warning and fails open.
    return 0;
  }
}

// In an autonomous work turn with a bound builder, downgrade the delegated
// shell/network grant to implement-equivalent so no provider (Claude git
// push/gh pr, Codex network) receives a raw-delivery capability. The bound
// builder tools/envelope remain the only delivery path. Non-autonomous callers
// keep their explicitly selected profile (legacy deliver lane).
export function autonomousWorkProfile({ autonomous, githubBuilder, mode, workProfile }) {
  if (autonomous && githubBuilder && mode === "work") return "implement";
  return workProfile;
}

export function localReviewPublicationPolicy(agent, result) {
  if (!["ollama", "docker"].includes(agent) || !result?.available || !result.binding) return result;
  return {
    ...result,
    authorizing: false,
    binding: { ...result.binding, publishStatusGate: false },
    statusGateAvailable: false,
  };
}

export function localReviewEnvelopePolicy(agent, authoredEnvelope) {
  if (!["ollama", "docker"].includes(agent) || authoredEnvelope.event === "COMMENT") return authoredEnvelope;
  const verdict = authoredEnvelope.event === "APPROVE" ? "approval" : "request for changes";
  return {
    ...authoredEnvelope,
    event: "COMMENT",
    body: `Evaluation-only local ${verdict} (non-authorizing):\n\n${authoredEnvelope.body}`,
  };
}

export function staticReviewBoundary({ agent, prompt, verificationPlan }) {
  if (!verificationPlan?.staticOnly) return { prompt, progress: null };
  const count = verificationPlan.withheldVerificationCommands.length;
  const commandLabel = `verification command${count === 1 ? "" : "s"}`;
  const summary = `${agent} cannot enforce exact command grants; continuing as a static review with ${count} ${commandLabel} withheld. Local and hosted CI remain separate evidence.`;
  return {
    prompt: `${prompt}\n\nStatic-review boundary:\n- The coordinator requested ${count} ${commandLabel}, but this provider cannot enforce an exact command grant.\n- Those commands were withheld. Do not run or claim them.\n- Perform the exact-head static review and treat local/full CI and hosted CI only as separately reported evidence.`,
    progress: { progress: null, total: null, summary },
  };
}

// A raw-delivery shell command that must never be granted to an autonomous
// provider; delivery must flow through the bound builder canonical operations.
const RAW_DELIVERY_COMMAND = /(^|\s|&|;|\|)(git\s+push|gh\s+pr\s+(create|edit|merge|ready|close|reopen|review|comment)|gh\s+api)\b/;

export function createAgentPool({
  root,
  workspace = root,
  models = {},
  modelFallbacks = {},
  allowClaudeFable = false,
  verificationCommands = [],
  reusableVerificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath = null,
  githubReview = null,
  githubBuilder = null,
  requestTimeoutMs = 4 * 60 * 60 * 1000 + 5 * 60 * 1000,
  turnTimeoutSeconds = 600,
  autonomous = false,
  writableRoots = [],
  onTiming = async () => {},
  createCredential = createInstallationToken,
  inspectAppRoles = inspectGitHubAppRoles,
  builderClientFactory = createBoundBuilderClient,
  // Test-only injection points. Production callers must use the default MCP
  // client and stdio transport so provider dispatch cannot bypass its boundary.
  clientFactory = ({ name, version }) => new Client({ name, version }),
  transportFactory = (options) => new StdioClientTransport(options),
}) {
  const emitTiming = async (event) => {
    await Promise.resolve(onTiming(event)).catch(() => {});
  };
  // Fail-closed autonomy: an autonomous council/portfolio/take-the-helm lane may
  // only deliver GitHub mutations through a bound githubBuilder. Without one it
  // must not fall back to raw push, gh pull-request mutation, gh api, PAT, or
  // ambient git credentials. An explicitly user-selected legacy lane is only the
  // non-autonomous caller (autonomous === false).
  if (autonomous) {
    // Reject raw-delivery commands in EVERY autonomous mode, including when a
    // bound builder exists: the builder's canonical operations are the only
    // permitted delivery path, never a raw shell command.
    const smuggled = (workCommands || []).find((command) => RAW_DELIVERY_COMMAND.test(command));
    if (smuggled) {
      throw new Error(`Autonomous delivery must use the bound githubBuilder canonical operations; a raw delivery command is not permitted: ${smuggled}`);
    }
    // Without a bound builder there is no canonical delivery path at all.
    if (workProfile === "deliver" && !githubBuilder) {
      throw new Error("Autonomous delivery requires a bound githubBuilder; raw push, gh pull-request mutation, PAT, or ambient git credentials are not permitted in autonomous council/portfolio flows.");
    }
  }

  const clients = {};
  const reviewPublication = new Map();
  const writerBindings = new Map();

  async function writerBuilderContext(agent) {
    if (!githubBuilder) return null;
    if (writerBindings.has(agent)) return writerBindings.get(agent);
    const promise = (async () => {
      const mintedCredential = await createCredential({
        role: "builder",
        writerProvider: agent,
        repository: githubBuilder.repository,
      });
      const { token: _discardedToken, ...credential } = mintedCredential;
      const appRoles = await inspectAppRoles();
      const explicitlyPinnedLogin = githubBuilder.expectedLogins?.[agent] || null;
      const compatibilityLogin = appRoles.roles?.builder?.expectedLogin || null;
      const priorWriterLogin = githubBuilder.writerProvider && githubBuilder.writerProvider !== agent
        ? appRoles.roles?.writers?.[githubBuilder.writerProvider]?.expectedLogin || null
        : null;
      let authorizedBy = null;
      if (explicitlyPinnedLogin && !sameGitHubAppLogin(explicitlyPinnedLogin, credential.expectedLogin)) {
        throw new Error(`Configured ${agent} writer identity ${credential.expectedLogin} does not match the bound authorization ${explicitlyPinnedLogin}.`);
      }
      // A per-provider expectedLogins pin is the explicit authorization for
      // that provider and deliberately supersedes the compatibility/top-level
      // login. Both values originate in the same trusted builder binding.
      if (explicitlyPinnedLogin) {
        authorizedBy = "explicit_provider_pin";
      } else if (sameGitHubAppLogin(githubBuilder.expectedLogin, credential.expectedLogin)) {
        authorizedBy = "resolved_writer_identity";
      } else if (sameGitHubAppLogin(githubBuilder.expectedLogin, compatibilityLogin)) {
        authorizedBy = "compatibility_builder";
      } else if (sameGitHubAppLogin(githubBuilder.expectedLogin, priorWriterLogin)) {
        authorizedBy = "prior_writer_failover";
      } else if (githubBuilder.expectedLogin) {
        throw new Error(`Configured ${agent} writer identity ${credential.expectedLogin} is not authorized by the builder binding ${githubBuilder.expectedLogin}.`);
      }
      const { expectedLogins: _expectedLogins, requestedLogin, rebindReason, ...baseBinding } = githubBuilder;
      const allowedOperations = (baseBinding.allowedOperations || []).filter((operation) => operation !== "merge");
      if (!allowedOperations.length) {
        throw new Error("Writer bindings cannot be authorized for merge alone; merge remains with the compatibility builder.");
      }
      return {
        credential,
        binding: {
          ...baseBinding,
          expectedLogin: credential.expectedLogin,
          writerProvider: credential.provider || agent,
          allowedOperations,
        },
        authority: {
          provider: credential.provider || agent,
          roleLabel: credential.roleLabel,
          login: credential.expectedLogin,
          requestedLogin: requestedLogin || githubBuilder.expectedLogin || null,
          resolvedLogin: credential.expectedLogin,
          rebindReason: sameGitHubAppLogin(requestedLogin || githubBuilder.expectedLogin, credential.expectedLogin)
            ? null
            : authorizedBy === "explicit_provider_pin"
              ? "explicit_provider_pin"
              : authorizedBy === "prior_writer_failover"
                ? "provider_failover"
                : rebindReason || (credential.provider ? "provider_writer_selection" : "compatibility_builder_fallback"),
          removedOperations: (baseBinding.allowedOperations || []).filter((operation) => operation === "merge"),
          appId: credential.appId,
          installationId: credential.installationId,
          repository: githubBuilder.repository,
          permissions: credential.permissions,
        },
      };
    })();
    writerBindings.set(agent, promise);
    promise.catch(() => {
      if (writerBindings.get(agent) === promise) writerBindings.delete(agent);
    });
    return promise;
  }

  async function reviewPublicationFor(agent) {
    if (reviewPublication.has(agent)) return reviewPublication.get(agent);
    const result = await resolveReviewPublication({
      agent,
      githubReview,
      configuredLogin: configuredReviewerLogin,
      createCredential: createInstallationToken,
    });
    const effective = localReviewPublicationPolicy(agent, result);
    reviewPublication.set(agent, effective);
    return effective;
  }

  async function publishValidatedEnvelope(envelope, reviewBinding, agent) {
    // Containment is validated before any parent directory is created; the bound
    // publisher process recursively creates the authorized parent directory.
    const absoluteHandoffPath = resolveContainedHandoffPath(workspace, handoffPath, {
      label: `${agent} handoffPath`,
    });
    const publisher = new Client({ name: "agent-bridge-antigravity-review-publisher", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(root, "src/github-review-bridge.mjs")],
      cwd: root,
      env: {
        ...process.env,
        GITHUB_REVIEW_REPOSITORY: reviewBinding.repository,
        GITHUB_REVIEW_PR_NUMBER: String(reviewBinding.prNumber),
        GITHUB_REVIEW_HEAD_SHA: reviewBinding.headSha,
        GITHUB_REVIEW_EXPECTED_LOGIN: reviewBinding.expectedLogin,
        GITHUB_REVIEW_PUBLISH_STATUS_GATE: reviewBinding.publishStatusGate ? "1" : "0",
        GITHUB_REVIEW_HANDOFF_PATH: absoluteHandoffPath,
        GITHUB_REVIEW_TOKEN_FILE: resolve(process.env.HOME, ".config/ghtoken"),
      },
    });
    const timingKey = `publication:${agent}:${Date.now()}`;
    await emitTiming({ action: "start", name: "publication", key: timingKey, at: new Date().toISOString(), metadata: { agent, channel: "github_review" } });
    try {
      await publisher.connect(transport, { timeout: 5_000 });
      const handoff = await publisher.callTool({
        name: "write_handoff",
        arguments: { content: envelope.handoff },
      });
      if (handoff.isError) throw new Error(`${agent} handoff publication failed: ${textFrom(handoff)}`);
      const review = await submitReviewWithSummaryCompatibility({
        envelope,
        submit: (arguments_) => publisher.callTool({
          name: "submit_pr_review",
          arguments: arguments_,
        }),
        onDowngrade: () => emitTiming({
          action: "milestone",
          name: "review_summary_compatibility_downgrade",
          at: new Date().toISOString(),
          metadata: { agent, channel: "github_review" },
        }),
      });
      if (review.isError) throw new Error(`${agent} PR review publication failed: ${textFrom(review)}`);
      return review.structuredContent;
    } finally {
      await publisher.close().catch(() => {});
      await emitTiming({ action: "finish", name: "publication", key: timingKey, at: new Date().toISOString(), metadata: { agent, channel: "github_review" } });
    }
  }

  async function publishEnvelopeReview(agent, message, reviewBinding, providedEnvelope = null) {
    // Validate the envelope exactly once. If a validated envelope already exists,
    // publication is retried without re-running the Antigravity provider.
    const authoredEnvelope = providedEnvelope || parseReviewEnvelope(message);
    const envelope = localReviewEnvelopePolicy(agent, authoredEnvelope);
    return republishValidatedReview({
      envelope,
      publish: (validated) => publishValidatedEnvelope(validated, reviewBinding, agent),
    });
  }

  async function boundBuilderClient(agent) {
    if (!githubBuilder) throw new Error("No bound GitHub builder authorization is configured.");
    const context = await writerBuilderContext(agent);
    const { credential } = context;
    const activeGithubBuilder = context.binding;
    const appRoles = await inspectAppRoles();
    const trustedReviewLogins = [
      appRoles.roles?.reviewer?.expectedLogin,
      ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.expectedLogin),
    ].filter(Boolean);
    const trustedReviewAppIds = [
      appRoles.roles?.reviewer?.appId,
      ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.appId),
    ].filter(Boolean).map(Number);
    const getToken = async () => {
      const fresh = await createCredential({
        role: "builder",
        writerProvider: agent,
        repository: activeGithubBuilder.repository,
      });
      if (!sameGitHubAppLogin(fresh.expectedLogin, credential.expectedLogin)
        || String(fresh.appId) !== String(credential.appId)
        || Number(fresh.installationId) !== Number(credential.installationId)) {
        throw new Error(`Configured ${agent} writer authority changed while the collaboration was running.`);
      }
      return {
        token: fresh.token,
        verifiedLogin: fresh.verifiedLogin,
        expiresAt: fresh.expiresAt,
        permissions: fresh.permissions,
      };
    };
    return builderClientFactory({
      ...activeGithubBuilder,
      expectedLogin: credential.expectedLogin,
      getToken,
      authority: context.authority,
      requiredReviewStatusContext: "agent-review",
      trustedReviewLogins,
      trustedReviewAppIds,
      trustedHumanReviewLogins: appRoles.mergePolicy?.trustedHumanReviewers || [],
      mergeEnforcement: appRoles.github?.mergeEnforcement || "broker",
      workspace: activeGithubBuilder.workspace || workspace,
      receiptPath: activeGithubBuilder.receiptPath || resolve(workspace, ".bridge", "github-builder-receipts.jsonl"),
      allowWorkspaceHead: activeGithubBuilder.allowWorkspaceHead === true,
    });
  }

  async function publishAntigravityBuilder(envelope) {
    if (envelope.operations.length === 0) return [];
    const builder = await boundBuilderClient("antigravity");
    const receipts = [];
    const timingKey = `publication:antigravity-builder:${Date.now()}`;
    await emitTiming({ action: "start", name: "publication", key: timingKey, at: new Date().toISOString(), metadata: { agent: "antigravity", channel: "github_builder" } });
    try {
      for (const operation of envelope.operations) {
        const { operation: name, ...input } = operation;
        if (name === "ensure_pull_request") receipts.push(await builder.ensurePullRequest(input));
        else if (name === "reply_review_thread") receipts.push(await builder.replyReviewThread(input));
        else if (name === "resolve_review_thread") receipts.push(await builder.resolveReviewThread(input));
        else if (name === "mark_ready") receipts.push(await builder.markReady());
        else if (name === "merge") receipts.push(await builder.merge(input));
        else if (name === "create_branch") receipts.push(await builder.createBranch(input));
        else if (name === "push_branch") receipts.push(await builder.pushBranch(input));
        else if (name === "replace_branch") receipts.push(await builder.replaceBranch(input));
      }
    } finally {
      await emitTiming({ action: "finish", name: "publication", key: timingKey, at: new Date().toISOString(), metadata: { agent: "antigravity", channel: "github_builder" } });
    }
    return receipts;
  }

  // Validate, optionally repair, then publish exactly once. The bounded repair
  // loop itself lives in builder-delivery-repair.mjs so it stays independently
  // testable without live builder credentials.
  async function deliverAntigravityBuilder({ message, conversationId, threads, requestRepair, onProgress, activeGithubBuilder }) {
    return deliverBuilderEnvelope({
      message,
      conversationId,
      githubBuilder: activeGithubBuilder,
      threads,
      requestRepair,
      onProgress,
      emitTiming,
      publish: publishAntigravityBuilder,
      readWorkspaceHead: () => (activeGithubBuilder?.allowWorkspaceHead ? workspaceHead(workspace) : null),
    });
  }

  async function clientFor(agent) {
    if (clients[agent]) return clients[agent];
    const scripts = {
      claude: "scripts/claude-bridge-mcp.sh",
      codex: "scripts/codex-mcp.sh",
      antigravity: "scripts/antigravity-bridge-mcp.sh",
      ollama: "scripts/ollama-bridge-mcp.sh",
      docker: "scripts/docker-bridge-mcp.sh",
    };
    const timingKey = `provider_startup:${agent}`;
    await emitTiming({ action: "start", name: "provider_startup", key: timingKey, at: new Date().toISOString(), metadata: { agent } });
    const client = clientFactory({ name: `agent-bridge-worker-${agent}`, version: "0.2.0", agent });
    const transport = transportFactory({
      command: "/bin/zsh",
      args: [resolve(root, scripts[agent])],
      cwd: root,
      env: { ...process.env, BRIDGE_DELEGATED_SESSION: "1" },
    }, agent);
    try {
      await client.connect(transport, { timeout: 5_000 });
      clients[agent] = client;
      await emitTiming({ action: "finish", name: "provider_startup", key: timingKey, at: new Date().toISOString(), metadata: { agent } });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      await emitTiming({ action: "finish", name: "provider_startup", key: timingKey, at: new Date().toISOString(), metadata: { agent, error: error.message } });
      throw error;
    }
  }

  return {
    async probe(agent) {
      try {
        const client = await clientFor(agent);
        const tools = await client.listTools({}, { timeout: 5_000 });
        if (!tools.tools?.length) throw new Error(`${agent} MCP server exposed no tools.`);
        if (agent === "ollama") {
          const health = await client.callTool({
            name: "get_ollama_status",
            arguments: models.ollama ? { model: models.ollama } : {},
          }, undefined, { timeout: LOCAL_REVIEW_PREFLIGHT_BUDGET_MS });
          if (health.isError) throw new Error(textFrom(health));
        }
        if (agent === "docker") {
          const health = await client.callTool({
            name: "get_docker_status",
            arguments: models.docker ? { model: models.docker } : {},
          }, undefined, { timeout: LOCAL_REVIEW_PREFLIGHT_BUDGET_MS });
          if (health.isError) throw new Error(textFrom(health));
        }
        const publication = await reviewPublicationFor(agent);
        return {
          agent,
          available: true,
          reviewPublication: githubReview
            ? {
              available: publication.available,
              authorizing: publication.authorizing !== false,
              reason: publication.reason,
              statusGateAvailable: publication.statusGateAvailable ?? false,
            }
            : null,
        };
      } catch (error) {
        return { agent, available: false, reason: error?.message || String(error) };
      }
    },
    async send({ agent, prompt, sessionId, mode, browser }, onProgress = () => {}) {
      const writerContext = mode === "work" && githubBuilder
        ? await writerBuilderContext(agent)
        : null;
      const activeGithubBuilder = writerContext?.binding || null;
      const requestedProviderCommands = agent === "claude" && mode === "review"
        ? [...new Set([...verificationCommands, ...reusableVerificationCommands])]
        : verificationCommands;
      // Issue #55: fail closed on command authority without failing the review itself.
      // Providers that cannot enforce exact grants receive zero commands and continue
      // as static reviewers; local/hosted verification remains separate evidence.
      const verificationPlan = providerVerificationPlanForRequest({
        provider: agent,
        mode,
        verificationCommands: requestedProviderCommands,
      });
      const runnableVerificationCommands = verificationPlan.verificationCommands;
      assertProviderVerificationCapability({ provider: agent, mode, verificationCommands: runnableVerificationCommands });
      // Enforce the coordinator command allowlist on every provider request path before
      // dispatch. Review calls may run only the verification gates; work calls also cover
      // the coordinator work commands. Any command outside the allowlist fails here.
      admitProviderCommands({ mode, verificationCommands: runnableVerificationCommands, workCommands });
      const client = await clientFor(agent);
      const permissionDecision = providerPermissionDecisionForRequest({
        provider: agent,
        mode,
        verificationCommands: runnableVerificationCommands,
        permissionProfile,
      });
      const effectivePermissionProfile = permissionDecision.permissionProfile;
      // Autonomous work with a bound builder runs on an implement-equivalent
      // shell/network grant; the bound builder tools remain the delivery path.
      const effectiveWorkProfile = autonomousWorkProfile({ autonomous, githubBuilder: activeGithubBuilder, mode, workProfile });
      const publication = mode === "review" ? await reviewPublicationFor(agent) : { available: true, binding: null, reason: null };
      const effectiveGithubReview = publication.available ? publication.binding : null;
      let effectivePrompt = mode === "review" && githubReview && !publication.available
        ? localReviewPrompt(prompt, publication.reason)
        : prompt;
      const staticBoundary = staticReviewBoundary({ agent, prompt: effectivePrompt, verificationPlan });
      effectivePrompt = staticBoundary.prompt;
      if (staticBoundary.progress) {
        onProgress({ at: new Date().toISOString(), ...staticBoundary.progress });
      }
      let request;
      let builderThreads = [];
      // Reused for a bounded delivery-repair turn so the correction keeps the
      // exact same workspace, permission profile, and provider conversation.
      const antigravityRequestFor = (antigravityPrompt, antigravitySessionId, overrides = {}) => antigravityToolRequest({
        prompt: antigravityPrompt,
        sessionId: antigravitySessionId,
        cwd: workspace,
        mode,
        model: models.antigravity,
        fallbackModels: modelFallbacks.antigravity,
        timeoutSeconds: turnTimeoutSeconds,
        permissionProfile: effectivePermissionProfile,
        verificationCommands: permissionDecision.verificationCommands,
        writableRoots,
        ...overrides,
      });
      if (agent === "claude") {
        request = claudeToolRequest({
          prompt: effectivePrompt,
          sessionId,
          cwd: workspace,
          mode,
          browser,
          model: models.claude,
          fallbackModels: modelFallbacks.claude,
          allowFable: allowClaudeFable,
          verificationCommands: runnableVerificationCommands,
          workCommands,
          workProfile: effectiveWorkProfile,
          permissionProfile: effectivePermissionProfile,
          handoffPath,
          githubReview: effectiveGithubReview,
          githubBuilder: activeGithubBuilder,
          timeoutSeconds: turnTimeoutSeconds,
          writableRoots,
        });
      } else if (agent === "codex") {
        request = codexToolRequest({
          prompt: effectivePrompt,
          sessionId,
          cwd: workspace,
          mode,
          browser,
          model: models.codex,
          fallbackModels: modelFallbacks.codex,
          workProfile: effectiveWorkProfile,
          permissionProfile: effectivePermissionProfile,
          verificationCommands: permissionDecision.verificationCommands,
          handoffPath,
          githubReview: effectiveGithubReview,
          githubReviewBridgePath: resolve(root, "src/github-review-bridge.mjs"),
          githubBuilder: activeGithubBuilder,
          githubBuilderBridgePath: resolve(root, "src/github-builder-bridge.mjs"),
          playwrightBridgePath: resolve(root, "scripts/playwright-mcp.sh"),
          writableRoots,
        });
      } else if (agent === "antigravity") {
        let antigravityPrompt = effectiveGithubReview
          ? `${effectivePrompt}${reviewEnvelopeInstructions({ githubReview: effectiveGithubReview, handoffPath })}`
          : effectivePrompt;
        if (activeGithubBuilder) {
          const builder = await boundBuilderClient(agent);
          builderThreads = activeGithubBuilder.prNumber ? await builder.reviewThreads() : [];
          antigravityPrompt += builderEnvelopeInstructions({ githubBuilder: activeGithubBuilder, threads: builderThreads });
        }
        request = antigravityRequestFor(antigravityPrompt, sessionId);
      } else if (agent === "ollama") {
        const ollamaPrompt = effectiveGithubReview
          ? `${effectivePrompt}${reviewEnvelopeInstructions({ githubReview: effectiveGithubReview, handoffPath, provider: "Ollama" })}`
          : effectivePrompt;
        request = ollamaToolRequest({
          prompt: ollamaPrompt,
          sessionId,
          cwd: workspace,
          mode,
          model: models.ollama,
          fallbackModels: modelFallbacks.ollama,
          timeoutSeconds: turnTimeoutSeconds,
        });
      } else if (agent === "docker") {
        const dockerPrompt = effectiveGithubReview
          ? `${effectivePrompt}${reviewEnvelopeInstructions({ githubReview: effectiveGithubReview, handoffPath, provider: "Docker Model Runner" })}`
          : effectivePrompt;
        request = dockerToolRequest({
          prompt: dockerPrompt,
          sessionId,
          cwd: workspace,
          mode,
          model: models.docker,
          fallbackModels: modelFallbacks.docker,
          timeoutSeconds: turnTimeoutSeconds,
        });
      } else {
        throw new Error(`Unsupported provider: ${agent}`);
      }
      request._meta = { progressToken: `${agent}-${Date.now()}` };
      const fallbackSlots = providerFallbackSlots(agent, modelFallbacks);
      const maxTotalTimeoutMs = requestTimeoutMs * (1 + fallbackSlots);
      const reviewEvidenceNotBefore = new Date().toISOString();
      let result;
      try {
        result = await client.callTool(request, undefined, {
          timeout: requestTimeoutMs,
          maxTotalTimeout: maxTotalTimeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => onProgress({
            at: new Date().toISOString(),
            progress: progress.progress,
            total: progress.total,
            summary: progress.message || null,
          }),
        });
      } catch (error) {
        if (/timed out|timeout|transport closed|connection closed/i.test(error?.message || String(error))) {
          error.indeterminate = true;
        }
        throw error;
      }
      if (result.isError) throw new Error(`${agent} MCP call failed: ${textFrom(result)}`);
      let message = textFrom(result);
      let publishedReviewReceipt = null;
      if (["antigravity", "ollama", "docker"].includes(agent) && effectiveGithubReview) {
        publishedReviewReceipt = await publishEnvelopeReview(agent, message, effectiveGithubReview);
        message = `${message}\n\nBound review published as ${publishedReviewReceipt.login}: ${publishedReviewReceipt.url}`;
      }
      let resolvedSessionId = sessionFrom(agent, result);
      let deliveryRepair = null;
      if (agent === "antigravity" && activeGithubBuilder) {
        const delivery = await deliverAntigravityBuilder({
          message,
          conversationId: resolvedSessionId,
          threads: builderThreads,
          onProgress,
          activeGithubBuilder,
          requestRepair: async ({ prompt: repairPrompt, conversationId }) => {
            // A delivery-syntax correction may not run commands; only the
            // envelope is being rewritten.
            const repairRequest = antigravityRequestFor(repairPrompt, conversationId, { verificationCommands: [] });
            repairRequest._meta = { progressToken: `antigravity-delivery-repair-${Date.now()}` };
            const repairResult = await client.callTool(repairRequest, undefined, {
              timeout: requestTimeoutMs,
              maxTotalTimeout: maxTotalTimeoutMs,
              resetTimeoutOnProgress: true,
              onprogress: (progress) => onProgress({
                at: new Date().toISOString(),
                progress: progress.progress,
                total: progress.total,
                summary: progress.message || null,
              }),
            });
            if (repairResult.isError) throw new Error(`antigravity delivery repair failed: ${textFrom(repairResult)}`);
            return { message: textFrom(repairResult), conversationId: sessionFrom(agent, repairResult) };
          },
        });
        deliveryRepair = delivery.deliveryRepair;
        resolvedSessionId = delivery.conversationId || resolvedSessionId;
        if (deliveryRepair.repaired) {
          message = `${message}\n\nDelivery repair: the builder envelope was corrected to canonical fields in the same Antigravity conversation after ${deliveryRepair.attempts.length} attempt(s); the implementation commit was unchanged.`;
        }
        message = `${message}\n\nBound builder operations published: ${JSON.stringify(delivery.receipts)}`;
      }
      const structured = result.structuredContent || {};
      const latestReviewTrustRoster = mode === "review" && effectiveGithubReview
        ? await readLatestReviewTrustEvidence({
          repository: effectiveGithubReview.repository,
          prNumber: effectiveGithubReview.prNumber,
          headSha: effectiveGithubReview.headSha,
          reviewerLogin: effectiveGithubReview.expectedLogin,
          notBefore: reviewEvidenceNotBefore,
        })
        : null;
      const publicationSucceeded = Boolean(publishedReviewReceipt) || structured.reviewPublished === true;
      const reviewTrustRoster = effectiveGithubReview
        ? reviewTrustRosterForPublication({
          latestEvidence: latestReviewTrustRoster,
          githubReview: effectiveGithubReview,
          publicationSucceeded,
        })
        : null;
      const routing = structured.modelRouting || structured;
      return {
        message,
        sessionId: resolvedSessionId,
        metadata: {
          deliveryRepair,
          usage: structured.usage || structured.tokenUsage || null,
          durationMs: structured.durationMs || structured.duration_ms || null,
          timing: structured.timing || null,
          verificationResults: structured.verificationResults || [],
          permissionProfile: effectivePermissionProfile,
          permissionReason: permissionDecision.permissionReason,
          modelRouting: ["claude", "codex", "antigravity", "ollama", "docker"].includes(agent) ? {
            requestedModel: routing.requestedModel ?? null,
            model: routing.model ?? null,
            fallbackUsed: routing.fallbackUsed ?? null,
            attemptedModels: routing.attemptedModels || routing.modelsUsed || [],
            fallbackModels: routing.modelFallbacks || routing.fallbackModels || modelFallbacks[agent] || [],
            fallbackManagedBy: routing.fallbackManagedBy ?? null,
          } : null,
          writerAuthority: writerContext?.authority || null,
          writerBinding: activeGithubBuilder ? {
            expectedLogin: activeGithubBuilder.expectedLogin,
            writerProvider: activeGithubBuilder.writerProvider,
          } : null,
          workspaceHeadSha: mode === "work" && activeGithubBuilder?.allowWorkspaceHead
            ? workspaceHead(workspace)
            : null,
          workspaceHeadShaSource: mode === "work" && activeGithubBuilder?.allowWorkspaceHead
            ? "post_turn_isolated_checkout"
            : null,
          reviewPublication: mode === "review" && githubReview ? {
            available: publication.available,
            published: publicationSucceeded,
            receipt: publishedReviewReceipt,
            authorizing: publication.authorizing !== false,
            login: effectiveGithubReview?.expectedLogin || null,
            reason: publication.reason,
            statusGateAvailable: publication.statusGateAvailable ?? false,
            humanApprovalRequired: !publication.available || publication.authorizing === false,
            trustRoster: reviewTrustRoster,
          } : null,
        },
      };
    },
    async close() {
      await Promise.allSettled(Object.values(clients).map((client) => client.close()));
    },
  };
}
